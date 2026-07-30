import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CacheService } from './cache.service';
import { MetricsService, METRICS } from '../observability/metrics.service';
import type { FoodhubRequest } from '../common/request-types';

export const RATE_LIMIT = 'foodhub:rate-limit';

export interface RateLimitOptions {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** What to bucket by. `tenant` is the noisy-neighbour lever. */
  by?: 'ip' | 'tenant' | 'phone';
}

/** Tighten a specific route: `@RateLimit({ limit: 5, windowSeconds: 60 })`. */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT, options);

/**
 * Fixed-window rate limiting with a per-tenant bucket.
 *
 * The tenant bucket is the important one: on a shared database, one vendor running a
 * scraper or a runaway integration degrades every other vendor's storefront. Capping
 * per tenant means the blast radius of a noisy neighbour is that neighbour.
 *
 * Fixed windows can admit up to 2× the limit across a boundary. That is an acceptable
 * trade for O(1) state and no clock coordination — this is abuse protection, not
 * billing.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  /** Applied to every route unless overridden. Generous — real customers never hit it. */
  private readonly defaults: RateLimitOptions = {
    limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300),
    windowSeconds: 60,
    by: 'ip',
  };

  /** Separate, much lower ceiling for a single vendor's total API traffic. */
  private readonly tenantCeiling = {
    limit: Number(process.env.RATE_LIMIT_TENANT_PER_MINUTE ?? 1200),
    windowSeconds: 60,
  };

  constructor(
    private readonly reflector: Reflector,
    private readonly cache: CacheService,
    private readonly metrics: MetricsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    if (process.env.RATE_LIMIT_DISABLED === '1') return true;

    const req = ctx.switchToHttp().getRequest<FoodhubRequest>();
    const res = ctx.switchToHttp().getResponse();

    // Scrape targets and health checks must never be throttled — a rate-limited
    // /metrics makes an outage invisible exactly when you need the data.
    if (req.path === '/metrics' || req.path === '/health') return true;

    const route =
      this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? this.defaults;

    const identity = this.identity(req, route.by ?? 'ip');
    const routeKey = `${req.method}:${(req.route?.path as string) ?? req.path}`;

    const allowed = await this.consume(`rl:${routeKey}:${identity}`, route.limit, route.windowSeconds, res);
    if (!allowed) {
      this.metrics.inc(METRICS.RATE_LIMITED, { scope: 'route' }, 1, 'Requests rejected by rate limiting');
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests — slow down and try again shortly.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (req.tenant) {
      const ok = await this.consume(
        `rl:tenant:${req.tenant.id}`,
        this.tenantCeiling.limit,
        this.tenantCeiling.windowSeconds,
      );
      if (!ok) {
        this.metrics.inc(METRICS.RATE_LIMITED, { scope: 'tenant' }, 1);
        throw new HttpException(
          { code: 'TENANT_RATE_LIMITED', message: 'This store is temporarily over its request limit.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }

  private identity(req: FoodhubRequest, by: 'ip' | 'tenant' | 'phone'): string {
    if (by === 'tenant') return req.tenant?.id ?? clientIp(req);
    if (by === 'phone') {
      const body = (req.body ?? {}) as any;
      const phone = body?.address?.phone ?? body?.phone ?? '';
      return String(phone).replace(/\D/g, '').slice(-10) || clientIp(req);
    }
    return req.user?.id ?? clientIp(req);
  }

  private async consume(key: string, limit: number, windowSeconds: number, res?: any): Promise<boolean> {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const bucketKey = `${key}:${window}`;

    // Atomic increment, so concurrent requests can't both read the same count and
    // each decide they're under the limit.
    const next = await this.cache.increment(bucketKey, windowSeconds + 1);

    if (res && !res.headersSent) {
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - next)));
      res.setHeader('X-RateLimit-Reset', String((window + 1) * windowSeconds));
    }
    return next <= limit;
  }
}

/**
 * The real client IP. Behind Caddy the socket address is the proxy, so the left-most
 * X-Forwarded-For entry is the caller — trusted here only because nothing but our own
 * edge can reach the API port.
 */
function clientIp(req: FoodhubRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}
