import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../infra/cache.service';
import { TenantContext } from '../common/tenant-context';
import type { RequestTenant } from '../common/request-types';

const TTL = 120; // seconds — short, so a domain change goes live fast
const NEGATIVE = '__none__';

/**
 * Host -> tenant. Called on essentially every storefront request, so it is cached and
 * the negative result is cached too (otherwise a bot hammering unknown hostnames turns
 * into a DB query per request).
 */
@Injectable()
export class TenantResolverService {
  private readonly logger = new Logger(TenantResolverService.name);
  /** Apex domain without port, e.g. "foodhub.com.bd". */
  private readonly apex: string;
  private readonly marketplaceHost: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    this.apex = stripPort(config.get<string>('platformDomain') ?? '');
    this.marketplaceHost = stripPort(config.get<string>('marketplaceHost') ?? '');
    this.logger.log(`Routing: *.${this.apex} -> vendor storefronts, ${this.marketplaceHost} -> marketplace`);
  }

  /** True when this host is the mother marketplace rather than a vendor storefront. */
  isMarketplaceHost(host: string): boolean {
    const h = stripPort(host);
    return h === this.marketplaceHost || h === `www.${this.marketplaceHost}`;
  }

  async byHost(rawHost: string): Promise<RequestTenant | null> {
    const host = stripPort(rawHost);
    if (!host || this.isMarketplaceHost(host)) return null;

    const cacheKey = `tenant:host:${host}`;
    const cached = await this.cache.get<RequestTenant | typeof NEGATIVE>(cacheKey);
    if (cached === NEGATIVE) return null;
    if (cached) return cached as RequestTenant;

    const resolved = await this.lookup(host);
    await this.cache.set(cacheKey, resolved ?? NEGATIVE, TTL);
    return resolved;
  }

  private async lookup(host: string): Promise<RequestTenant | null> {
    // Custom domain wins over the platform subdomain: a vendor may have both.
    const domain = await TenantContext.runAsPlatform('host -> tenant resolution', () =>
      this.prisma.db.domain.findUnique({
        where: { hostname: host },
        select: { tenantId: true, verifiedAt: true, id: true },
      }),
    );

    if (domain) {
      const tenant = await this.loadTenant(domain.tenantId, 'custom-domain');
      // First request proves DNS actually points at us — flip the domain to verified.
      if (tenant && !domain.verifiedAt) {
        TenantContext.runAsPlatform('mark custom domain verified on first hit', () =>
          this.prisma.db.domain
            .update({
              where: { id: domain.id },
              data: { verifiedAt: new Date(), sslStatus: 'ACTIVE' },
            })
            .catch(() => undefined),
        );
      }
      return tenant;
    }

    if (this.apex && host.endsWith(`.${this.apex}`)) {
      const slug = host.slice(0, -(this.apex.length + 1));
      if (!slug || slug.includes('.')) return null;
      const tenant = await TenantContext.runAsPlatform('subdomain -> tenant resolution', () =>
        this.prisma.db.tenant.findUnique({ where: { slug }, select: TENANT_SELECT }),
      );
      return tenant ? toRequestTenant(tenant, 'subdomain') : null;
    }

    return null;
  }

  async byId(tenantId: string, via: RequestTenant['via'] = 'jwt'): Promise<RequestTenant | null> {
    return this.loadTenant(tenantId, via);
  }

  async bySlug(slug: string): Promise<RequestTenant | null> {
    const tenant = await TenantContext.runAsPlatform('slug -> tenant resolution', () =>
      this.prisma.db.tenant.findUnique({ where: { slug }, select: TENANT_SELECT }),
    );
    return tenant ? toRequestTenant(tenant, 'explicit') : null;
  }

  private async loadTenant(tenantId: string, via: RequestTenant['via']): Promise<RequestTenant | null> {
    const key = `tenant:id:${tenantId}`;
    const cached = await this.cache.get<RequestTenant>(key);
    if (cached) return { ...cached, via };

    const tenant = await TenantContext.runAsPlatform('load tenant by id', () =>
      this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: TENANT_SELECT }),
    );
    if (!tenant) return null;
    const shaped = toRequestTenant(tenant, via);
    await this.cache.set(key, shaped, TTL);
    return shaped;
  }

  /** Call after any write that changes a tenant's identity, plan or domains. */
  async invalidate(tenantId: string, hostnames: string[] = []): Promise<void> {
    await this.cache.del(`tenant:id:${tenantId}`, ...hostnames.map((h) => `tenant:host:${stripPort(h)}`));
  }

  /**
   * Caddy's on-demand TLS `ask` endpoint hits this before issuing a certificate.
   * Without it anyone could point a DNS record at us and make us mint unlimited certs.
   */
  async isCertificateAllowed(rawHost: string): Promise<boolean> {
    const host = stripPort(rawHost);
    if (!host) return false;
    if (this.isMarketplaceHost(host)) return true;
    if (this.apex && (host === this.apex || host.endsWith(`.${this.apex}`))) return true;
    const domain = await TenantContext.runAsPlatform('caddy on-demand TLS ask', () =>
      this.prisma.db.domain.findUnique({ where: { hostname: host }, select: { id: true } }),
    );
    return Boolean(domain);
  }
}

const TENANT_SELECT = {
  id: true,
  slug: true,
  name: true,
  plan: true,
  planStatus: true,
  isOpen: true,
  listedOnMarketplace: true,
  commissionRateBps: true,
} as const;

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  plan: any;
  planStatus: any;
  isOpen: boolean;
  listedOnMarketplace: boolean;
  commissionRateBps: number;
};

function toRequestTenant(t: TenantRow, via: RequestTenant['via']): RequestTenant {
  return { ...t, via };
}

export function stripPort(host: string): string {
  return (host ?? '').toLowerCase().trim().split(':')[0];
}
