import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import { map } from 'rxjs/operators';
import type { Observable } from 'rxjs';

export const EDGE_CACHE = 'foodhub:edge-cache';

export interface EdgeCacheOptions {
  /** Seconds a shared cache may serve this without revalidating. */
  sMaxAge: number;
  /** Seconds a stale copy may still be served while revalidating in the background. */
  staleWhileRevalidate?: number;
}

/**
 * Mark a public GET as edge-cacheable.
 *
 * `stale-while-revalidate` is what makes a menu feel instant under load: the CDN keeps
 * serving the slightly-old copy at zero latency while it refreshes behind the scenes,
 * so a cache expiry never turns into a user-visible stall.
 */
export const EdgeCache = (options: EdgeCacheOptions) => SetMetadata(EDGE_CACHE, options);

@Injectable()
export class CacheHeadersInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<EdgeCacheOptions>(EDGE_CACHE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    const req = ctx.switchToHttp().getRequest();
    const res = ctx.switchToHttp().getResponse();

    // HEAD is served by the GET handler and is what a cache uses to revalidate,
    // so it must receive the same caching headers rather than no-store.
    const cacheable = req.method === 'GET' || req.method === 'HEAD';
    if (!options || !cacheable) {
      // Anything not explicitly marked cacheable must not be cached — an order status
      // page served from a CDN is a data leak, not a performance win.
      if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store');
      return next.handle();
    }

    return next.handle().pipe(
      map((body) => {
        const swr = options.staleWhileRevalidate ?? options.sMaxAge * 4;
        res.setHeader(
          'Cache-Control',
          `public, max-age=0, s-maxage=${options.sMaxAge}, stale-while-revalidate=${swr}`,
        );
        // Vendor resolution depends on the Host, so caches must key on it too —
        // without this one vendor's menu can be served on another's domain.
        res.setHeader('Vary', 'X-Tenant-Host, Accept-Encoding');

        const etag = weakEtag(body);
        if (etag) {
          res.setHeader('ETag', etag);
          if (req.headers['if-none-match'] === etag) {
            res.status(304);
            return undefined;
          }
        }
        return body;
      }),
    );
  }
}

function weakEtag(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  try {
    const hash = createHash('sha1').update(JSON.stringify(body)).digest('base64url').slice(0, 27);
    return `W/"${hash}"`;
  } catch {
    return null;
  }
}
