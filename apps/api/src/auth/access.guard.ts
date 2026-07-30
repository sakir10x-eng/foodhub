import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '@foodhub/shared';
import { TenantContext } from '../common/tenant-context';
import { IS_PUBLIC, PLATFORM_SCOPE, REQUIRE_TENANT, ROLES } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { FoodhubRequest } from '../common/request-types';
import { TenantResolverService } from '../tenancy/tenant-resolver.service';

/**
 * One guard does authentication, authorisation AND tenant-scope binding.
 *
 * Keeping them together is deliberate: scope binding depends on both the Host header and
 * the JWT, and splitting it across a guard and an interceptor is how you end up with a
 * route that runs unbound. Ordering here is the whole security model:
 *
 *   1. @PlatformScope  -> cross-tenant reads (marketplace, platform admin)
 *   2. authenticated vendor -> their own tenant, regardless of which host they called
 *   3. Host header     -> the storefront's tenant (public, unauthenticated)
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly resolver: TenantResolverService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;

    const req = ctx.switchToHttp().getRequest<FoodhubRequest>();
    const meta = <T>(key: string) =>
      this.reflector.getAllAndOverride<T>(key, [ctx.getHandler(), ctx.getClass()]);

    const isPublic = meta<boolean>(IS_PUBLIC) ?? false;
    const roles = meta<Role[]>(ROLES);
    const platformReason = meta<string>(PLATFORM_SCOPE);
    const requireTenant = meta<boolean>(REQUIRE_TENANT) ?? false;

    // ── authenticate (optional on public routes: a logged-in customer still gets `user`)
    const token = extractToken(req);
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<JwtPayload>(token);
        req.user = {
          id: payload.sub,
          email: payload.email,
          name: payload.name ?? '',
          role: payload.role,
          tenantId: payload.tenantId ?? null,
        };
      } catch {
        if (!isPublic) throw new UnauthorizedException('Session expired — sign in again');
      }
    }

    const needsAuth = !isPublic || Boolean(roles?.length);
    if (needsAuth && !req.user) throw new UnauthorizedException('Authentication required');

    if (roles?.length && req.user && !roles.includes(req.user.role)) {
      throw new ForbiddenException('You do not have access to this resource');
    }

    // ── bind the tenant scope
    if (platformReason) {
      TenantContext.bindPlatform(platformReason);
    } else if (req.user?.role === 'PLATFORM_ADMIN') {
      TenantContext.bindPlatform('platform admin session');
    } else if (req.user?.tenantId) {
      const tenant = await this.resolver.byId(req.user.tenantId, 'jwt');
      if (!tenant) throw new UnauthorizedException('Your vendor account no longer exists');
      req.tenant = tenant;
      TenantContext.bindTenant(tenant.id);
    } else if (req.tenant) {
      TenantContext.bindTenant(req.tenant.id);
    }

    if (requireTenant && !req.tenant) {
      throw new BadRequestException(
        'No vendor resolved for this request. Call it on a vendor domain or pass X-Tenant-Host.',
      );
    }

    // A suspended vendor's storefront goes dark; their admin panel stays reachable so
    // they can pay the invoice that un-suspends them.
    if (req.tenant?.planStatus === 'SUSPENDED' && isPublic) {
      throw new ForbiddenException({
        code: 'STORE_SUSPENDED',
        message: 'This store is temporarily unavailable.',
      });
    }

    return true;
  }
}

interface JwtPayload {
  sub: string;
  email: string;
  name?: string;
  role: Role;
  tenantId?: string | null;
}

function extractToken(req: FoodhubRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const cookie = (req as any).cookies?.fh_access;
  return typeof cookie === 'string' && cookie ? cookie : null;
}
