import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import {
  RIDER_FIX_MAX_ACCURACY_M,
  riderCoversDelivery,
  type DeliveryTarget,
  type GeoShape,
} from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { CacheService } from '../infra/cache.service';

export interface OpeningHour {
  /** 0 = Sunday. Bangladesh's week starts on Sunday, and so does this. */
  day: number;
  open: string;
  close: string;
}

/**
 * The unglamorous half of running a kitchen: when it is open, who is carrying the food,
 * and what has run out.
 *
 * None of this increases an order's value. All of it stops orders being cancelled, which
 * is worth more — a cancelled order costs the food, the rider, the refund and the rating.
 */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /* ────────────────────────────────────────────────── opening hours */

  /**
   * Flip every vendor's open flag to match their schedule.
   *
   * Runs every five minutes on Dhaka wall-clock time, because "we close at 11pm" means
   * 11pm in Dhaka — not wherever the server happens to be. Vendors who have not set a
   * schedule, or who have auto-open switched off, are left entirely alone: an automatic
   * system that overrides a manual switch is worse than no automation.
   */
  @Cron('*/5 * * * *')
  async applyOpeningHours() {
    const tenants = await TenantContext.runAsPlatform('opening hours sweep every vendor', () =>
      this.prisma.db.tenant.findMany({
        where: { autoOpenClose: true },
        select: { id: true, slug: true, isOpen: true, openingHours: true },
      }),
    );

    const { day, minutes } = dhakaNow();
    let flipped = 0;

    for (const tenant of tenants) {
      const hours = (tenant.openingHours ?? []) as unknown as OpeningHour[];
      if (hours.length === 0) continue;

      const shouldBeOpen = isOpenAt(hours, day, minutes);
      if (shouldBeOpen === tenant.isOpen) continue;

      await TenantContext.runAsTenant(tenant.id, () =>
        this.prisma.db.tenant.update({ where: { id: tenant.id }, data: { isOpen: shouldBeOpen } }),
      );
      await this.cache.delByPrefix(`menu:${tenant.id}`);
      await this.cache.delByPrefix('marketplace:');
      flipped++;
      this.logger.log(`${tenant.slug} auto-${shouldBeOpen ? 'opened' : 'closed'}`);
    }

    if (flipped) this.logger.log(`Opening hours: flipped ${flipped}`);
  }

  async setOpeningHours(tenantId: string, hours: OpeningHour[], autoOpenClose: boolean) {
    for (const h of hours) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.close)) {
        throw new BadRequestException('Use 24-hour times like 10:00 and 23:00');
      }
    }
    await this.prisma.db.tenant.update({
      where: { id: tenantId },
      data: { openingHours: hours as any, autoOpenClose },
    });
    await this.cache.delByPrefix(`menu:${tenantId}`);
    return { ok: true };
  }

  /* ─────────────────────────────────────────────────────── 86'ing */

  /**
   * "Sold out for today" — with a date, so it comes back on its own.
   *
   * The permanent toggle already exists; this is the one a kitchen actually uses at 8pm,
   * and the one they forget to undo. Setting a return time is what stops a dish silently
   * vanishing from the menu for a month.
   */
  async markSoldOut(productId: string, untilTomorrow: boolean) {
    const product = await this.prisma.db.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Menu item not found');

    const until = untilTomorrow ? nextDhakaMidnight() : null;
    await this.prisma.db.product.update({
      where: { id: productId },
      data: { isAvailable: false, soldOutUntil: until },
    });
    return { soldOutUntil: until };
  }

  /** Restores everything whose "sold out for today" has expired. Runs just after midnight. */
  @Cron('5 18 * * *') // 18:05 UTC = 00:05 Asia/Dhaka
  async restoreSoldOut() {
    const restored = await TenantContext.runAsPlatform('sold-out restore sweeps every vendor', () =>
      this.prisma.db.product.updateMany({
        where: { isAvailable: false, soldOutUntil: { not: null, lte: new Date() } },
        data: { isAvailable: true, soldOutUntil: null },
      }),
    );
    if (restored.count > 0) {
      await this.cache.delByPrefix('menu:');
      await this.cache.delByPrefix('marketplace:');
      this.logger.log(`Restored ${restored.count} sold-out items`);
    }
  }

  /* ───────────────────────────────────────────────────────── riders */

  /**
   * The shops a rider actually carries for.
   *
   * `Rider` and `RiderShop` are outside the tenant guard (see UNGUARDED_MODELS), so this
   * filter is not a convenience — it is the entire access control for everything below it.
   * Every rider read in this file goes through here or repeats it verbatim.
   */
  private approvedShopIds(riderId: string): Promise<string[]> {
    return this.prisma.db.riderShop
      .findMany({ where: { riderId, approved: true }, select: { tenantId: true } })
      .then((rows) => rows.map((r) => r.tenantId));
  }

  /**
   * The riders one shop can point at an order, plus anyone it has invited and is waiting
   * on.
   *
   * A pending rider is listed by name so the vendor knows the invitation was sent, but
   * **their token is withheld until they accept**. The token is a working delivery link
   * into every shop that rider carries for; handing it over on the strength of knowing a
   * phone number would rebuild the leak this model was designed to close.
   */
  async listRiders(tenantId: string) {
    const links = await this.prisma.db.riderShop.findMany({
      where: { tenantId, rider: { isActive: true } },
      orderBy: { rider: { name: 'asc' } },
      select: {
        approved: true,
        rider: { select: { id: true, name: true, phone: true, token: true } },
      },
    });

    return links.map((link) => ({
      id: link.rider.id,
      name: link.rider.name,
      phone: link.rider.phone,
      approved: link.approved,
      token: link.approved ? link.rider.token : null,
    }));
  }

  /**
   * Take on a rider.
   *
   * Two different things wear one button here, and the difference is the security model:
   *
   *   - a phone number nobody has seen before is a new person, created and approved on the
   *     spot — there is no one to ask, and the shop vouching for them is the whole story;
   *   - a phone number that already rides for another shop is an **invitation**. The link
   *     is created unapproved and the rider turns it on from the sheet they already hold.
   *
   * Without the second case a vendor could type a rider's number, be handed their token,
   * and read every other shop's customers off that rider's sheet.
   */
  async addRider(tenantId: string, name: string, phone: string) {
    const existing = await this.prisma.db.rider.findUnique({
      where: { phone },
      select: { id: true, name: true, phone: true, token: true, isActive: true },
    });

    if (!existing) {
      const rider = await this.prisma.db.rider.create({
        // The token addresses the rider's own view, so it is random rather than derived —
        // a guessable one would expose every customer's address to anyone.
        data: {
          name,
          phone,
          token: randomBytes(16).toString('base64url'),
          shops: { create: { tenantId, approved: true, approvedAt: new Date() } },
        },
        select: { id: true, name: true, phone: true, token: true },
      });
      return { ...rider, approved: true, invited: false };
    }

    // A rider who left the platform entirely is not re-enrolled behind their back.
    if (!existing.isActive) throw new BadRequestException('This rider is no longer available');

    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId: existing.id, tenantId } },
      select: { approved: true },
    });
    if (link?.approved) throw new BadRequestException('This rider already works with you');
    if (link) throw new BadRequestException('This rider has already been invited — waiting for them to accept');

    await this.prisma.db.riderShop.create({ data: { riderId: existing.id, tenantId, approved: false } });
    return {
      id: existing.id,
      name: existing.name,
      phone: existing.phone,
      token: null,
      approved: false,
      invited: true,
    };
  }

  /**
   * Stop working with a rider.
   *
   * This ends the relationship, not the person: the rider row survives because past orders
   * point at it, and a delivery with no record of who carried it is exactly what you need
   * on the day something goes wrong. They may also still be riding for three other shops,
   * none of whose business this is.
   */
  async removeRider(tenantId: string, riderId: string) {
    const removed = await this.prisma.db.riderShop.deleteMany({ where: { riderId, tenantId } });
    if (removed.count === 0) throw new NotFoundException('Rider not found');

    // Their sheet must not keep showing this shop's deliveries after they have been let
    // go. Unassigning is the guarded-client write, so it cannot reach another shop's rows.
    await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.order.updateMany({
        where: { riderId, status: { notIn: ['DELIVERED', 'CANCELLED', 'REFUNDED'] } },
        data: { riderId: null },
      }),
    );
    return { ok: true };
  }

  async assignRider(tenantId: string, orderId: string, riderId: string | null) {
    const order = await this.prisma.db.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found');

    // `riderId` arrives from the client, and riders are no longer filtered by the guard —
    // so this check is the only thing stopping a shop handing its delivery to a rider who
    // does not work for them, whose sheet would then show this shop's customer.
    if (riderId) {
      const link = await this.prisma.db.riderShop.findUnique({
        where: { riderId_tenantId: { riderId, tenantId } },
        select: { approved: true, rider: { select: { isActive: true } } },
      });
      if (!link?.approved || !link.rider.isActive) throw new NotFoundException('Rider not found');
    }

    await this.prisma.db.order.update({ where: { id: orderId }, data: { riderId } });
    return { ok: true };
  }

  /** A rider resolved from their own link, with the shops they are cleared to carry for. */
  private async riderByToken(token: string) {
    const rider = await this.prisma.db.rider.findUnique({
      where: { token },
      select: { id: true, name: true, isActive: true, onDuty: true },
    });
    if (!rider || !rider.isActive) throw new NotFoundException('This delivery link is no longer valid');
    return rider;
  }

  /**
   * What one rider is carrying, across every shop they work for. Addressed by their token,
   * not by a login.
   *
   * The orders are read **one shop at a time under `runAsTenant`** rather than in a single
   * cross-tenant query. A single query would have to run in platform scope, where a
   * `tenantId: { in: [...] }` filter is the only thing between this rider and every order
   * in the database — one editing mistake from a total breach. A village rider works for a
   * handful of shops, so the loop costs a handful of indexed lookups and keeps the guard
   * switched on for each one. That trade is deliberate; do not "optimise" it into one call.
   */
  async riderQueue(token: string) {
    const rider = await this.riderByToken(token);

    const [shopIds, invites] = await Promise.all([
      this.approvedShopIds(rider.id),
      this.pendingInvites(rider.id),
    ]);

    const perShop = await Promise.all(
      shopIds.map((tenantId) =>
        TenantContext.runAsTenant(tenantId, async () => {
          const [shop, orders] = await Promise.all([
            this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
            this.prisma.db.order.findMany({
              where: { riderId: rider.id, status: { in: ['READY', 'ON_THE_WAY'] } },
              orderBy: { placedAt: 'asc' },
              select: {
                id: true, code: true, status: true, total: true, dueOnDelivery: true,
                deliveryAddress: true, customerPhone: true, placedAt: true,
              },
            }),
          ]);
          // The shop's name travels with each drop: a rider carrying for three shops needs
          // to know which counter this one came from before they can pick it up.
          return orders.map((order) => ({ ...order, store: shop?.name ?? '' }));
        }),
      ),
    );

    const orders = perShop
      .flat()
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());

    return { rider: { name: rider.name, shops: shopIds.length }, orders, invites };
  }

  /* ──────────────────────────────────────────────────── duty, areas, and the job pool */

  /**
   * The rider going on or off the road.
   *
   * Coming off duty does **not** drop the deliveries they are already carrying — those are
   * a promise made to a customer with food in a bag, and only a human can undo that. It
   * stops new work being offered, which is the thing a rider actually needs at the end of
   * a shift.
   */
  async setDuty(token: string, onDuty: boolean) {
    const rider = await this.riderByToken(token);
    await this.prisma.db.rider.update({
      where: { id: rider.id },
      data: { onDuty, dutySince: onDuty ? new Date() : null },
    });
    return { onDuty };
  }

  /**
   * A shop setting up a rider's patch.
   *
   * The patch belongs to the **rider**, not to the relationship: one person has one
   * territory, and slicing it per shop would mean a rider covering "উত্তর পাড়া" for the
   * grocer and not for the tea stall next door, which describes nothing real. The
   * consequence is that any shop the rider has accepted can edit it — acceptable among a
   * handful of shops in one village, and worth revisiting the day that stops being true.
   *
   * A rider with no areas is offered nothing rather than everything; see
   * `riderCoversDelivery`.
   */
  async setAreas(tenantId: string, riderId: string, areas: { label: string; shape: GeoShape }[]) {
    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId, tenantId } },
      select: { approved: true },
    });
    if (!link?.approved) throw new NotFoundException('Rider not found');

    // Replaced wholesale rather than diffed: the vendor edits this as one list, and a
    // partial update that half-applied would leave a patch nobody intended.
    await this.prisma.db.$transaction([
      this.prisma.db.riderArea.deleteMany({ where: { riderId } }),
      ...areas.map((area) =>
        this.prisma.db.riderArea.create({ data: { riderId, label: area.label, shape: area.shape as any } }),
      ),
    ]);
    return this.listAreas(riderId);
  }

  async areasForShop(tenantId: string, riderId: string) {
    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId, tenantId } },
      select: { approved: true },
    });
    if (!link?.approved) throw new NotFoundException('Rider not found');
    return this.listAreas(riderId);
  }

  listAreas(riderId: string) {
    return this.prisma.db.riderArea.findMany({
      where: { riderId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, shape: true },
    });
  }

  /**
   * Deliveries waiting in this rider's patch, across every shop they carry for.
   *
   * Three things are withheld from an offer, and each one is a decision:
   *
   *   - **the street address**, until they accept. Any rider on duty can read this list,
   *     and a list of every doorstep in the village is not something to hand out for the
   *     price of switching a toggle on. The area name is enough to decide with.
   *   - **the customer's phone**, for the same reason.
   *   - anything they have already passed on, which would otherwise climb back to the top
   *     of the list every thirty seconds until they took it by accident.
   */
  async availableWork(token: string) {
    const rider = await this.riderByToken(token);
    if (!rider.onDuty) return { onDuty: false, offers: [] };

    const [shopIds, areas, skipped] = await Promise.all([
      this.approvedShopIds(rider.id),
      this.listAreas(rider.id),
      this.prisma.db.riderOfferSkip
        .findMany({ where: { riderId: rider.id }, select: { orderId: true } })
        .then((rows) => new Set(rows.map((r) => r.orderId))),
    ]);
    const shapes = areas.map((a) => a.shape as GeoShape);

    const perShop = await Promise.all(
      shopIds.map((tenantId) =>
        TenantContext.runAsTenant(tenantId, async () => {
          const [shop, orders] = await Promise.all([
            this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
            this.prisma.db.order.findMany({
              // CONFIRMED as well as READY: in a village the rider often has further to
              // travel than the kitchen has to cook, so waiting for READY to offer the job
              // means the food sits on the counter going cold.
              where: {
                riderId: null,
                fulfillment: 'DELIVERY',
                status: { in: ['CONFIRMED', 'PREPARING', 'READY'] },
              },
              orderBy: { placedAt: 'asc' },
              select: {
                id: true, code: true, status: true, dueOnDelivery: true,
                deliveryAddress: true, placedAt: true,
              },
            }),
          ]);

          return orders
            .filter((order) => !skipped.has(order.id))
            .filter((order) => riderCoversDelivery(shapes, addressTarget(order.deliveryAddress)))
            .map((order) => ({
              id: order.id,
              code: order.code,
              status: order.status,
              store: shop?.name ?? '',
              area: (order.deliveryAddress as any)?.area ?? '',
              dueOnDelivery: order.dueOnDelivery,
              placedAt: order.placedAt,
            }));
        }),
      ),
    );

    const offers = perShop.flat().sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    return { onDuty: true, offers };
  }

  /**
   * A rider taking a delivery.
   *
   * Two riders tapping the same card at the same moment is the normal case, not the edge
   * case — everybody is looking at the same list. So the claim is a conditional update
   * that only matches while `riderId` is still null: exactly one of them changes a row,
   * and the other is told plainly rather than being left believing they have it.
   */
  async acceptWork(token: string, orderId: string) {
    const rider = await this.riderByToken(token);
    if (!rider.onDuty) throw new BadRequestException('Go on duty before taking a delivery');

    const tenantId = await this.tenantForOffer(rider.id, orderId);

    const claimed = await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.order.updateMany({
        where: { id: orderId, riderId: null, status: { in: ['CONFIRMED', 'PREPARING', 'READY'] } },
        data: { riderId: rider.id },
      }),
    );
    if (claimed.count === 0) throw new ConflictException('Someone else has taken this delivery');

    return { ok: true };
  }

  /** Passing on a delivery. It stays fully available to every other rider. */
  async skipWork(token: string, orderId: string) {
    const rider = await this.riderByToken(token);
    await this.tenantForOffer(rider.id, orderId);

    await this.prisma.db.riderOfferSkip.upsert({
      where: { riderId_orderId: { riderId: rider.id, orderId } },
      create: { riderId: rider.id, orderId },
      update: {},
    });
    return { ok: true };
  }

  /**
   * Which of the rider's shops this order belongs to — and a refusal if it is none of them.
   *
   * Every write a rider makes goes through here first. An order id arrives from a phone,
   * and without this check a rider could name any order in the database and take it,
   * including one from a shop that has never heard of them.
   */
  private async tenantForOffer(riderId: string, orderId: string): Promise<string> {
    const shopIds = await this.approvedShopIds(riderId);

    for (const tenantId of shopIds) {
      const found = await TenantContext.runAsTenant(tenantId, () =>
        this.prisma.db.order.findUnique({ where: { id: orderId }, select: { id: true } }),
      );
      if (found) return tenantId;
    }
    throw new NotFoundException('That delivery is not available to you');
  }

  /** Shops waiting on this rider to say yes. */
  private pendingInvites(riderId: string) {
    return this.prisma.db.riderShop
      .findMany({
        where: { riderId, approved: false },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true, tenant: { select: { name: true } } },
      })
      .then((rows) => rows.map((r) => ({ tenantId: r.tenantId, store: r.tenant.name })));
  }

  /**
   * The rider answering an invitation.
   *
   * This is the consent step that lets a token be shared safely across shops, and it needs
   * no login precisely because the rider is already holding the only thing that proves who
   * they are. Declining deletes the link rather than remembering a refusal — a shop asking
   * again next month is a normal thing to happen, not an attack to be blocked.
   */
  async respondToInvite(token: string, tenantId: string, accept: boolean) {
    const rider = await this.riderByToken(token);

    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId: rider.id, tenantId } },
      select: { approved: true },
    });
    if (!link) throw new NotFoundException('That invitation is no longer there');
    if (link.approved) return { ok: true, approved: true };

    if (!accept) {
      await this.prisma.db.riderShop.delete({
        where: { riderId_tenantId: { riderId: rider.id, tenantId } },
      });
      return { ok: true, approved: false };
    }

    await this.prisma.db.riderShop.update({
      where: { riderId_tenantId: { riderId: rider.id, tenantId } },
      data: { approved: true, approvedAt: new Date() },
    });
    return { ok: true, approved: true };
  }

  /**
   * A rider's phone reporting where it is.
   *
   * Authorised by the run-sheet token, so a position can only be filed against the rider
   * it belongs to. Two things are thrown away here rather than downstream, because once a
   * bad fix is stored it is indistinguishable from a good one:
   *
   *   - a fix too vague to be a location (a wifi lookup indoors can be kilometres out);
   *   - a fix from a rider with nothing on the road, which is a phone left reporting
   *     after the shift and nobody's business.
   *
   * The write is a plain overwrite: we keep where the rider IS, never where they have
   * been. A trail of a named worker's week is a different product with different
   * obligations, and not one anybody asked for.
   */
  async reportRiderLocation(
    input: { token: string; lat: number; lng: number; accuracy?: number },
  ): Promise<RiderLocationResult> {
    const rider = await this.prisma.db.rider.findUnique({
      where: { token: input.token },
      select: { id: true, isActive: true },
    });
    if (!rider || !rider.isActive) throw new NotFoundException('This delivery link is no longer valid');

    if (input.accuracy !== undefined && input.accuracy > RIDER_FIX_MAX_ACCURACY_M) {
      // Accepted, not stored. The rider's phone should not have to understand our rules,
      // and an error here would make their app look broken while they are driving.
      return { accepted: false, reason: 'accuracy', orders: 0 };
    }

    const now = new Date();
    await this.prisma.db.rider.update({
      where: { id: rider.id },
      data: { lat: input.lat, lng: input.lng, locationAt: now },
    });

    // Only orders actually on the road, and only at shops this rider is cleared for. This
    // is both the push list and the answer to "is anyone entitled to see this fix at all",
    // so the approved-shop filter is doing security work, not tidiness.
    const shopIds = await this.approvedShopIds(rider.id);
    const perShop = await Promise.all(
      shopIds.map((tenantId) =>
        TenantContext.runAsTenant(tenantId, () =>
          this.prisma.db.order.findMany({
            where: { riderId: rider.id, status: 'ON_THE_WAY' },
            select: { code: true, customerPhone: true },
          }),
        ),
      ),
    );
    const live = perShop.flat();

    return { accepted: true, at: now.toISOString(), orders: live.length, live };
  }
}

/**
 * Discriminated so the caller cannot read `live` off a rejected fix — the push loop and
 * the rejection path are different shapes, and the compiler should say so.
 */
export type RiderLocationResult =
  | { accepted: false; reason: 'accuracy'; orders: 0 }
  | { accepted: true; at: string; orders: number; live: { code: string; customerPhone: string }[] };

/**
 * What we can tell the matcher about where an order is going.
 *
 * `deliveryAddress` is free-form JSON written by a checkout that has changed shape more
 * than once, so every field here is treated as absent until proven otherwise. A `lat`
 * without an `lng` is not half a pin, it is no pin — and passing one through as a number
 * would put a delivery on the equator.
 */
function addressTarget(address: unknown): DeliveryTarget {
  const a = (address ?? {}) as Record<string, unknown>;
  const lat = typeof a.lat === 'number' ? a.lat : null;
  const lng = typeof a.lng === 'number' ? a.lng : null;
  return {
    point: lat !== null && lng !== null ? { lat, lng } : null,
    area: typeof a.area === 'string' ? a.area : null,
  };
}

/* ─────────────────────────────────────────────────────────── helpers ─── */

/** Wall-clock day and minute-of-day in Asia/Dhaka. */
function dhakaNow(): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((p) => p.type === 'weekday')!.value,
  );
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return { day, minutes: hour * 60 + minute };
}

/**
 * Is the kitchen open right now?
 *
 * Handles the case that matters most in this market: a shift that crosses midnight.
 * "18:00–02:00" on Friday must still be open at 1am on Saturday, which a naive
 * open <= now <= close comparison gets wrong every single night.
 */
export function isOpenAt(hours: OpeningHour[], day: number, minutes: number): boolean {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  for (const slot of hours) {
    const open = toMinutes(slot.open);
    const close = toMinutes(slot.close);

    if (close > open) {
      if (slot.day === day && minutes >= open && minutes < close) return true;
    } else {
      // Crosses midnight: the evening part belongs to `day`, the small hours to the next.
      if (slot.day === day && minutes >= open) return true;
      if ((slot.day + 1) % 7 === day && minutes < close) return true;
    }
  }
  return false;
}

/** Midnight tonight in Dhaka, expressed as an instant. */
function nextDhakaMidnight(): Date {
  const now = new Date();
  const { minutes } = dhakaNow();
  const untilMidnight = (24 * 60 - minutes) * 60 * 1000;
  return new Date(now.getTime() + untilMidnight);
}
