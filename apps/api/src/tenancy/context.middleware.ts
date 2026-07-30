import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { TenantContext } from '../common/tenant-context';
import { TenantResolverService, stripPort } from './tenant-resolver.service';
import type { FoodhubRequest } from '../common/request-types';

/**
 * Opens the AsyncLocalStorage scope for the request and resolves the Host header to a
 * tenant. It deliberately does NOT bind the scope — AccessGuard does that once the JWT
 * has also been read, because an authenticated vendor's own tenant must win over
 * whatever host they happened to call.
 */
@Injectable()
export class ContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ContextMiddleware.name);

  constructor(private readonly resolver: TenantResolverService) {}

  use(req: FoodhubRequest, _res: Response, next: NextFunction) {
    TenantContext.enter(() => {
      // An explicit header beats the Host header — this is how the marketplace frontend
      // asks the API for one specific vendor's menu while running on our own domain.
      const forwardedHost = req.headers['x-tenant-host'];
      const host = typeof forwardedHost === 'string' && forwardedHost ? forwardedHost : (req.headers.host ?? '');
      req.resolvedHost = stripPort(host);

      this.resolver
        .byHost(host)
        .then((tenant) => {
          if (tenant) req.tenant = tenant;
        })
        // A failure here degrades to "no tenant" (the guard then 400s) rather than a
        // 500, but it must never be silent — a broken resolver would otherwise look
        // exactly like an unknown hostname.
        .catch((err) => this.logger.error(`Host resolution failed for "${req.resolvedHost}": ${err?.message}`, err?.stack))
        .finally(() => next());
    });
  }
}
