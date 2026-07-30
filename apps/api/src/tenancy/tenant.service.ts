import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeliveryZone,
  GatewayConfigInput,
  PLANS,
  Plan,
  PlanFeature,
  SmsConfigInput,
  PublicTenant,
  TenantSettingsInput,
  VendorSummary,
  estimateEta,
  normaliseCuisine,
} from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { TenantContext } from '../common/tenant-context';
import { CacheService } from '../infra/cache.service';
import { TenantResolverService } from './tenant-resolver.service';
import { PlanService } from './plan.service';
import { toImageRef, IMAGE_SELECT } from '../media/image.mapper';
import { mockGatewayAvailable } from '../payments/mock-gateway';

@Injectable()
export class TenantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly cache: CacheService,
    private readonly resolver: TenantResolverService,
    private readonly config: ConfigService,
    private readonly plans: PlanService,
  ) {}

  /** Everything the vendor admin panel needs about its own store. */
  async getOwnSettings(tenantId: string) {
    const tenant = await this.prisma.db.tenant.findUnique({
      where: { id: tenantId },
      include: { logo: { select: IMAGE_SELECT }, cover: { select: IMAGE_SELECT } },
    });
    if (!tenant) throw new NotFoundException('Store not found');

    // Neither secret ever leaves the server — only whether one is stored.
    const { gatewayConfig, smsConfig, ...rest } = tenant;
    return {
      ...rest,
      logo: toImageRef(tenant.logo, this.config),
      cover: toImageRef(tenant.cover, this.config),
      deliveryZones: (tenant.deliveryZones ?? []) as unknown as DeliveryZone[],
      // The credentials themselves never leave the server — only whether they exist.
      gateway: this.gatewayStatus(gatewayConfig),
      sms: this.smsStatus(smsConfig),
      // Whether an advance can be demanded at all. Decided here rather than inferred from
      // `gateway.configured` in the panel, so the button the vendor sees and the rule the
      // server enforces can never disagree.
      canRequireAdvance: Boolean(gatewayConfig) || mockGatewayAvailable(this.config),
      // What this plan unlocks, decided server-side. The panel renders locks from this
      // rather than re-implementing the matrix and drifting out of step with the guard.
      entitlements: {
        plan: tenant.plan,
        features: PLANS[tenant.plan as Plan].features,
        staffSeats: PLANS[tenant.plan as Plan].staffSeats,
        menuItems: PLANS[tenant.plan as Plan].menuItems,
        analyticsDays: PLANS[tenant.plan as Plan].analyticsDays,
      },
    };
  }

  async updateSettings(tenantId: string, input: TenantSettingsInput) {
    // The paywall, enforced where the write happens. The panel greys these out, but a
    // greyed-out button is a hint — this is the boundary.
    const GATED: [keyof TenantSettingsInput, PlanFeature][] = [
      ['loyaltyEnabled', 'LOYALTY'],
      ['aiAssistantEnabled', 'AI_ASSISTANT'],
      ['pickupEnabled', 'PICKUP'],
      ['schedulingEnabled', 'SCHEDULED_ORDERS'],
    ];
    for (const [field, feature] of GATED) {
      // Only turning a feature ON is gated. A vendor who has been downgraded must always
      // be able to switch the leftovers off.
      if (input[field] === true) await this.plans.require(tenantId, feature);
    }
    if (input.advancePercent !== undefined && input.advancePercent > 0) {
      await this.plans.require(tenantId, 'ADVANCE_PAYMENT');
    }

    const data: Record<string, unknown> = {};
    for (const key of [
      'name', 'tagline', 'brandColor', 'phone', 'address', 'lat', 'lng',
      'isOpen', 'listedOnMarketplace', 'prepMinutes', 'deliveryMinutes',
      // Phase 4: loyalty + AI assistant configuration.
      'loyaltyEnabled', 'pointsPerHundred', 'pointValue', 'minRedeemPoints',
      'aiAssistantEnabled', 'aiPersona',
      // Payment policy — what must be paid before the kitchen starts.
      'codEnabled', 'advancePercent', 'advanceThreshold',
      // Ordering for later.
      'schedulingEnabled', 'schedulingMaxDays',
      // The vendor's own ad accounts and invite programme.
      'metaPixelId', 'tiktokPixelId', 'ga4MeasurementId',
      'referralEnabled', 'referrerReward', 'refereeReward', 'referralMinSpend',
    ] as const) {
      if (input[key] !== undefined) data[key] = input[key];
    }
    if (input.logoId !== undefined) data.logoId = input.logoId;
    if (input.coverId !== undefined) data.coverId = input.coverId;
    if (input.cuisines !== undefined) {
      // Normalise before storing, not on read: the filter query matches the stored value
      // exactly, so "fast food" and "Fast Food" saved as-is would be two chips that each
      // find half the vendors.
      const unique = new Map<string, string>();
      for (const raw of input.cuisines) {
        const tag = normaliseCuisine(raw);
        if (tag) unique.set(tag.toLowerCase(), tag);
      }
      data.cuisines = [...unique.values()];
    }
    if (input.deliveryZones !== undefined) {
      if (input.deliveryZones.length === 0) {
        throw new BadRequestException('Keep at least one delivery zone');
      }
      // Zone ids address a zone from the storefront, so duplicates would make delivery
      // fees depend on array order.
      const ids = new Set(input.deliveryZones.map((z) => z.id));
      if (ids.size !== input.deliveryZones.length) {
        throw new BadRequestException('Each delivery area needs its own id');
      }
      data.deliveryZones = input.deliveryZones;
    }

    // The payment-policy fields arrive one at a time (the settings form saves on blur),
    // so the "no COD and no advance" dead end has to be checked against the MERGED state,
    // not just the payload — otherwise turning COD off on its own slips through and the
    // store silently accepts no orders at all.
    if (input.codEnabled !== undefined || input.advancePercent !== undefined) {
      const current = await this.prisma.db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { codEnabled: true, advancePercent: true, gatewayConfig: true },
      });
      const codEnabled = input.codEnabled ?? current.codEnabled;
      const advancePercent = input.advancePercent ?? current.advancePercent;

      if (!codEnabled && advancePercent === 0) {
        throw new BadRequestException(
          'Turn on 50% or 100% advance payment before switching cash on delivery off — otherwise no order can be placed',
        );
      }

      // The other way to lock yourself out: demand money up front with no way to take it.
      // An advance closes cash on delivery, so without a gateway the storefront accepts
      // nothing at all — and the vendor finds out from an empty order list, not an error.
      // The mock gateway counts, or a dev/demo deployment could never demo the feature.
      const canCollect = Boolean(current.gatewayConfig) || mockGatewayAvailable(this.config);
      if (advancePercent > 0 && !canCollect) {
        throw new BadRequestException(
          'Connect your payment gateway first — an advance payment cannot be collected without one',
        );
      }
    }

    // Anything shown on the storefront invalidates the cached menu payload.
    data.menuVersion = { increment: 1 };

    const tenant = await this.prisma.db.tenant.update({ where: { id: tenantId }, data });
    await this.afterTenantWrite(tenantId);
    return { ok: true, menuVersion: tenant.menuVersion };
  }

  /** The Mode B master switch. */
  async setMarketplaceListing(tenantId: string, listed: boolean) {
    if (listed) {
      const [productCount, tenant] = await Promise.all([
        this.prisma.db.product.count({ where: { isArchived: false, isAvailable: true } }),
        this.prisma.db.tenant.findUnique({
          where: { id: tenantId },
          select: { address: true, phone: true },
        }),
      ]);
      // Listing an empty or uncontactable store on the marketplace is worse than not
      // listing it — the first customer experience would be a dead end.
      if (productCount === 0) {
        throw new BadRequestException('Add at least one available menu item before listing on the marketplace');
      }
      if (!tenant?.address || !tenant.phone) {
        throw new BadRequestException('Add your store address and phone number before listing on the marketplace');
      }
    }
    await this.prisma.db.tenant.update({
      where: { id: tenantId },
      data: { listedOnMarketplace: listed, menuVersion: { increment: 1 } },
    });
    await this.afterTenantWrite(tenantId);
    return { listedOnMarketplace: listed };
  }

  /** Kitchen open/closed — flipped many times a day, so it is cheap and cache-busting. */
  async setOpen(tenantId: string, isOpen: boolean) {
    await this.prisma.db.tenant.update({ where: { id: tenantId }, data: { isOpen } });
    await this.afterTenantWrite(tenantId);
    return { isOpen };
  }

  /**
   * Store the vendor's OWN gateway credentials (Mode A) encrypted at rest.
   * We never read these back to any client and never use them for marketplace orders.
   */
  async setGatewayConfig(tenantId: string, input: GatewayConfigInput) {
    /*
     * Checked per provider, not generically.
     *
     * bKash Tokenized Checkout needs FOUR values — an app key/secret pair and a separate
     * merchant username/password. A generic "any two will do" check accepts a half-filled
     * bKash form, saves happily, and then every single payment fails at the token grant
     * with an error the vendor cannot interpret. Better to refuse it here, by name.
     */
    if (input.provider === 'BKASH') {
      const missing = [
        !input.appKey && 'app key',
        !input.appSecret && 'app secret',
        !input.username && 'merchant username',
        !input.passwordSecret && 'merchant password',
      ].filter(Boolean);
      if (missing.length) {
        throw new BadRequestException(`bKash also needs your ${missing.join(', ')}`);
      }
    } else if (input.provider !== 'NONE') {
      const hasCreds =
        (input.storeId && input.storePassword) || (input.appKey && input.appSecret);
      if (!hasCreds) {
        throw new BadRequestException('Enter the credentials for the selected gateway');
      }
    }
    const envelope = input.provider === 'NONE' ? null : this.crypto.encryptJson(input);
    await this.prisma.db.tenant.update({
      where: { id: tenantId },
      data: { gatewayConfig: envelope },
    });
    return this.gatewayStatus(envelope);
  }

  /** Decrypted credentials. Server-side only — payments module is the sole caller. */
  async readGatewayConfig(tenantId: string): Promise<GatewayConfigInput | null> {
    const row = await this.prisma.db.tenant.findUnique({
      where: { id: tenantId },
      select: { gatewayConfig: true },
    });
    if (!row?.gatewayConfig) return null;
    try {
      return this.crypto.decryptJson<GatewayConfigInput>(row.gatewayConfig);
    } catch {
      // A key rotation gone wrong must not look like "vendor has no gateway".
      throw new BadRequestException('Stored gateway credentials could not be decrypted — re-enter them');
    }
  }

  /** Store the vendor's own SMS account, encrypted the same way as gateway keys. */
  async setSmsConfig(tenantId: string, input: SmsConfigInput) {
    if (input.provider !== 'NONE' && !input.apiKey) {
      throw new BadRequestException('Enter the API key from your SMS account');
    }
    const envelope = input.provider === 'NONE' ? null : this.crypto.encryptJson(input);
    await this.prisma.db.tenant.update({ where: { id: tenantId }, data: { smsConfig: envelope } });
    return this.smsStatus(envelope);
  }

  /**
   * Decrypted SMS credentials. Server-side only.
   *
   * Returns null rather than throwing on a decrypt failure, unlike the gateway equivalent:
   * a rotated key must not stop order notifications going out entirely — falling back to
   * the platform account and logging is the better failure.
   */
  async readSmsConfig(tenantId: string): Promise<SmsConfigInput | null> {
    const row = await TenantContext.runAsPlatform('SMS credentials for one explicit tenant', () =>
      this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { smsConfig: true } }),
    );
    if (!row?.smsConfig) return null;
    try {
      return this.crypto.decryptJson<SmsConfigInput>(row.smsConfig);
    } catch {
      return null;
    }
  }

  private smsStatus(envelope: string | null) {
    if (!envelope) return { configured: false, senderId: '' };
    try {
      const cfg = this.crypto.decryptJson<SmsConfigInput>(envelope);
      return { configured: cfg.provider !== 'NONE', senderId: cfg.senderId ?? '' };
    } catch {
      return { configured: false, senderId: '' };
    }
  }

  private gatewayStatus(envelope: string | null) {
    if (!envelope) return { provider: 'NONE' as const, configured: false, sandbox: true, hint: '' };
    try {
      const cfg = this.crypto.decryptJson<GatewayConfigInput>(envelope);
      return {
        provider: cfg.provider,
        configured: true,
        sandbox: cfg.sandbox,
        hint: CryptoService.mask(cfg.storeId ?? cfg.appKey ?? cfg.username),
      };
    } catch {
      return { provider: 'NONE' as const, configured: false, sandbox: true, hint: 'decryption failed' };
    }
  }

  /** Public storefront/marketplace view of a vendor. Safe to cache and to serve anonymously. */
  async getPublicTenant(tenantId: string): Promise<PublicTenant> {
    const tenant = await TenantContext.runAsPlatform('public tenant profile read', () =>
      this.prisma.db.tenant.findUnique({
        where: { id: tenantId },
        include: { logo: { select: IMAGE_SELECT }, cover: { select: IMAGE_SELECT } },
      }),
    );
    if (!tenant) throw new NotFoundException('Store not found');
    return this.toPublic(tenant);
  }

  toPublic(tenant: any): PublicTenant {
    const zones = (tenant.deliveryZones ?? []) as DeliveryZone[];
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      tagline: tenant.tagline,
      brandColor: tenant.brandColor,
      logo: toImageRef(tenant.logo, this.config),
      cover: toImageRef(tenant.cover, this.config),
      isOpen: tenant.isOpen,
      prepMinutes: tenant.prepMinutes,
      address: tenant.address,
      phone: tenant.phone,
      deliveryZones: zones,
      pickupEnabled: tenant.pickupEnabled ?? false,
      pickupMinutes: tenant.pickupMinutes ?? 15,
      schedulingEnabled: tenant.schedulingEnabled ?? false,
      schedulingMaxDays: tenant.schedulingMaxDays ?? 3,
      lat: tenant.lat ?? null,
      lng: tenant.lng ?? null,
      marketing: {
        metaPixelId: tenant.metaPixelId ?? '',
        tiktokPixelId: tenant.tiktokPixelId ?? '',
        ga4MeasurementId: tenant.ga4MeasurementId ?? '',
      },
      referral: {
        enabled: tenant.referralEnabled ?? false,
        referrerReward: tenant.referrerReward ?? 0,
        refereeReward: tenant.refereeReward ?? 0,
        minSpend: tenant.referralMinSpend ?? 0,
      },
      // `null`, not 0: an unrated store is "New", and rendering a 0.0 next to a star
      // would read as "everybody hated it" rather than "nobody has been yet".
      rating: tenant.ratingCount > 0 ? tenant.ratingSum / tenant.ratingCount : null,
      ratingCount: tenant.ratingCount ?? 0,
      // Both ends, because one number cannot describe a vendor whose zones run ৳0–120.
      // Showing only the minimum told every customer "Free delivery" when almost none of
      // them lived in the one free zone.
      deliveryFeeRange: {
        min: zones.length ? Math.min(...zones.map((z) => z.fee)) : 0,
        max: zones.length ? Math.max(...zones.map((z) => z.fee)) : 0,
      },
      payment: {
        codEnabled: tenant.codEnabled ?? true,
        advancePercent: tenant.advancePercent ?? 0,
        advanceThreshold: tenant.advanceThreshold ?? 0,
      },
      minDeliveryFee: zones.length ? Math.min(...zones.map((z) => z.fee)) : 0,
      cuisines: tenant.cuisines ?? [],
      deliveryMinutes: tenant.deliveryMinutes ?? 20,
      // The distance-free window. A marketplace listing that knows how far the customer
      // is overwrites this with a sharper one; see MarketplaceService.nearMe.
      eta: estimateEta({
        prepMinutes: tenant.prepMinutes,
        deliveryMinutes: tenant.deliveryMinutes ?? 20,
        pickupMinutes: tenant.pickupMinutes ?? 15,
      }),
    };
  }

  /** Vendor dashboard header: today's numbers plus what we currently owe them. */
  async summary(tenantId: string): Promise<VendorSummary> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [tenant, todayAgg, activeOrders, payable] = await Promise.all([
      this.prisma.db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true, slug: true, name: true, plan: true, planStatus: true,
          isOpen: true, listedOnMarketplace: true, commissionRateBps: true,
          ratingSum: true, ratingCount: true,
        },
      }),
      this.prisma.db.order.aggregate({
        where: { placedAt: { gte: startOfDay }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        _count: { _all: true },
        _sum: { total: true },
      }),
      this.prisma.db.order.count({
        where: { status: { in: ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'ON_THE_WAY'] } },
      }),
      // Unsettled payable = credits for delivered orders minus any refunds clawed back.
      this.prisma.db.ledgerEntry.aggregate({
        where: { type: { in: ['VENDOR_PAYABLE', 'REFUND'] }, settlementId: null },
        _sum: { amount: true },
      }),
    ]);

    if (!tenant) throw new NotFoundException('Store not found');

    const { ratingSum, ratingCount, ...rest } = tenant;
    return {
      tenant: {
        ...rest,
        // Same rule as the storefront: no ratings means "New", never a 0.0.
        rating: ratingCount > 0 ? ratingSum / ratingCount : null,
        ratingCount,
      },
      today: {
        orders: todayAgg._count._all,
        revenue: todayAgg._sum.total ?? 0,
        activeOrders,
      },
      pendingPayout: payable._sum.amount ?? 0,
    };
  }

  /* ────────────────────────────────────────────────────────────── domains */

  async listDomains(tenantId: string) {
    const cnameTarget = this.config.get<string>('cnameTarget') ?? '';
    const domains = await this.prisma.db.domain.findMany({ orderBy: { createdAt: 'asc' } });
    return domains.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      sslStatus: d.sslStatus,
      isPrimary: d.isPrimary,
      verifiedAt: d.verifiedAt?.toISOString() ?? null,
      cnameTarget,
    }));
  }

  async addDomain(tenantId: string, hostname: string) {
    await this.plans.require(tenantId, 'CUSTOM_DOMAIN');

    const apex = (this.config.get<string>('platformDomain') ?? '').split(':')[0];
    if (apex && (hostname === apex || hostname.endsWith(`.${apex}`))) {
      throw new BadRequestException('Platform domains are assigned automatically — add your own domain instead');
    }

    // Uniqueness is global: two tenants claiming one hostname would make routing ambiguous.
    const taken = await TenantContext.runAsPlatform('custom domain uniqueness is global', () =>
      this.prisma.db.domain.findUnique({ where: { hostname }, select: { tenantId: true } }),
    );
    if (taken) {
      throw new ConflictException(
        taken.tenantId === tenantId ? 'You have already added this domain' : 'This domain is already connected to another store',
      );
    }

    const plan = await this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } });
    if (plan?.plan === 'FREE') {
      throw new BadRequestException('Custom domains are available on the Basic plan and above');
    }

    const existingCount = await this.prisma.db.domain.count();
    const domain = await this.prisma.db.domain.create({
      data: { tenantId, hostname, isPrimary: existingCount === 0 },
    });
    await this.resolver.invalidate(tenantId, [hostname]);

    return {
      id: domain.id,
      hostname: domain.hostname,
      sslStatus: domain.sslStatus,
      isPrimary: domain.isPrimary,
      verifiedAt: null,
      cnameTarget: this.config.get<string>('cnameTarget') ?? '',
    };
  }

  async removeDomain(tenantId: string, domainId: string) {
    const domain = await this.prisma.db.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');
    await this.prisma.db.domain.delete({ where: { id: domainId } });
    await this.resolver.invalidate(tenantId, [domain.hostname]);
    return { ok: true };
  }

  async setPrimaryDomain(tenantId: string, domainId: string) {
    const domain = await this.prisma.db.domain.findUnique({ where: { id: domainId } });
    if (!domain) throw new NotFoundException('Domain not found');
    await this.prisma.db.$transaction([
      this.prisma.db.domain.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } }),
      this.prisma.db.domain.update({ where: { id: domainId }, data: { isPrimary: true } }),
    ]);
    await this.resolver.invalidate(tenantId, [domain.hostname]);
    return { ok: true };
  }

  /* ─────────────────────────────────────────────────── platform admin */

  /** Cross-tenant listing. Only reachable behind @Roles('PLATFORM_ADMIN'). */
  async platformList(q: string) {
    const tenants = await this.prisma.db.tenant.findMany({
      where: q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { slug: { contains: q, mode: 'insensitive' } }] }
        : undefined,
      select: {
        id: true, slug: true, name: true, plan: true, planStatus: true,
        listedOnMarketplace: true, isOpen: true, commissionRateBps: true, createdAt: true,
        promotedUntil: true,
        _count: { select: { orders: true, products: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const now = new Date();
    // Collapsed to a boolean here: the console only asks "is it live", and an expired
    // promotion showing as a date reads like it is still running.
    return tenants.map(({ promotedUntil, ...t }) => ({
      ...t,
      promoted: Boolean(promotedUntil && promotedUntil > now),
    }));
  }

  /**
   * Platform-wide numbers for the superadmin console.
   *
   * Note which revenue is which: commission is what we earn on MARKETPLACE orders, and
   * subscription MRR is what we earn from OWN_STORE vendors. They are separate business
   * models and summing them into one "revenue" number would hide which one is working.
   */
  async platformOverview(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [tenants, orders, commission, subs, unpaidInvoices, pendingPayouts] = await Promise.all([
      this.prisma.readOnly.tenant.groupBy({ by: ['planStatus'], _count: { _all: true } }),
      this.prisma.readOnly.order.groupBy({
        by: ['channel'],
        where: { placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        _count: { _all: true },
        _sum: { total: true },
      }),
      this.prisma.readOnly.order.aggregate({
        where: { placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        _sum: { commissionAmount: true },
      }),
      this.prisma.readOnly.subscription.aggregate({
        where: { status: 'ACTIVE' },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.readOnly.invoice.aggregate({
        where: { status: { in: ['UNPAID', 'OVERDUE'] } },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.readOnly.settlement.aggregate({
        where: { status: 'PENDING' },
        _sum: { netPayable: true },
        _count: { _all: true },
      }),
    ]);

    const listed = await this.prisma.readOnly.tenant.count({ where: { listedOnMarketplace: true } });

    return {
      days,
      vendors: {
        total: tenants.reduce((a, t) => a + t._count._all, 0),
        byStatus: Object.fromEntries(tenants.map((t) => [t.planStatus, t._count._all])),
        onMarketplace: listed,
      },
      gmv: orders.reduce((a, o) => a + (o._sum.total ?? 0), 0),
      orders: orders.reduce((a, o) => a + o._count._all, 0),
      byChannel: orders.map((o) => ({
        channel: o.channel,
        orders: o._count._all,
        gmv: o._sum.total ?? 0,
      })),
      /** Mode B revenue: our cut of marketplace orders. */
      commissionEarned: commission._sum.commissionAmount ?? 0,
      /** Mode A revenue: recurring subscription fees. */
      subscriptionMrr: subs._sum.amount ?? 0,
      activeSubscriptions: subs._count._all,
      outstandingInvoices: { count: unpaidInvoices._count._all, amount: unpaidInvoices._sum.amount ?? 0 },
      pendingPayouts: { count: pendingPayouts._count._all, amount: pendingPayouts._sum.netPayable ?? 0 },
    };
  }

  async setCommission(tenantId: string, bps: number) {
    await this.prisma.db.tenant.update({ where: { id: tenantId }, data: { commissionRateBps: bps } });
    await this.resolver.invalidate(tenantId);
    return { commissionRateBps: bps };
  }

  async setPlanStatus(tenantId: string, status: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED') {
    await this.prisma.db.tenant.update({ where: { id: tenantId }, data: { planStatus: status } });
    await this.afterTenantWrite(tenantId);
    return { planStatus: status };
  }

  private async afterTenantWrite(tenantId: string) {
    // Explicit `where` because this also runs in platform scope (admin console), where
    // the tenant guard does not narrow the query for us.
    const domains = await this.prisma.db.domain.findMany({
      where: { tenantId },
      select: { hostname: true },
    });
    await this.resolver.invalidate(tenantId, domains.map((d) => d.hostname));
    await this.cache.delByPrefix(`menu:${tenantId}`);
    await this.cache.delByPrefix('marketplace:');
  }
}
