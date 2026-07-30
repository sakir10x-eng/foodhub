import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@foodhub/shared';
import type { RequestTenant } from './request-types';

export const IS_PUBLIC = 'foodhub:public';
export const ROLES = 'foodhub:roles';
export const PLATFORM_SCOPE = 'foodhub:platform-scope';
export const REQUIRE_TENANT = 'foodhub:require-tenant';

/** No authentication required. Storefront + marketplace reads and checkout. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restrict to the listed roles. Implies authentication. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

/**
 * Read across all tenants. Every use is an audited hole in tenant isolation, so the
 * reason string is mandatory and shows up in logs.
 */
export const PlatformScope = (reason: string) => SetMetadata(PLATFORM_SCOPE, reason);

/** 400 unless the request resolved to a tenant (via Host or the caller's JWT). */
export const RequireTenant = () => SetMetadata(REQUIRE_TENANT, true);

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  tenantId: string | null;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthedUser | null => {
  return ctx.switchToHttp().getRequest().user ?? null;
});

/** The tenant this request resolved to — from the Host header, or the caller's JWT. */
export const CurrentTenant = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestTenant => {
  const tenant = ctx.switchToHttp().getRequest().tenant;
  if (!tenant) throw new Error('No tenant on request — add @RequireTenant() to this route');
  return tenant;
});

/** Raw Host header, already lower-cased and stripped of the port. */
export const HostName = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().resolvedHost ?? '';
});
