import { AsyncLocalStorage } from 'node:async_hooks';

export type Scope = 'tenant' | 'platform' | 'none';

export interface TenantStore {
  scope: Scope;
  tenantId: string | null;
  /** Why platform scope was granted — shows up in leak diagnostics. */
  reason?: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

/**
 * Ambient tenant scope for the current request/job.
 *
 * Everything that touches a tenant-scoped model runs inside one of these. The Prisma
 * extension in prisma/tenant-guard.ts reads this store and refuses any query it cannot
 * confine to a single tenant, so forgetting a `where` clause is a 500, never a leak.
 *
 * A request enters an empty store in middleware; the AccessGuard then binds it once the
 * host and the JWT have both been read. Binding mutates the store in place, which is why
 * `enter()` must wrap everything downstream.
 */
export const TenantContext = {
  /** Open an unbound scope for the lifetime of `fn`. Nothing tenant-scoped works until bound. */
  enter<T>(fn: () => T): T {
    return storage.run({ scope: 'none', tenantId: null }, fn);
  },

  /**
   * Run with reads/writes pinned to one tenant.
   *
   * The callback is awaited INSIDE the storage scope, and that is load-bearing: a Prisma
   * promise does no work until something calls `.then()` on it, so a scope that merely
   * returns the promise would exit before the query — and its tenant-guard hook — ever
   * ran. Awaiting here means every call site is safe whether or not it awaits its own.
   */
  async runAsTenant<T>(tenantId: string, fn: () => T | Promise<T>): Promise<T> {
    if (!tenantId) throw new Error('runAsTenant requires a tenantId');
    return storage.run({ scope: 'tenant', tenantId }, async () => await fn());
  },

  /**
   * Run WITHOUT a tenant filter. Only for genuinely cross-tenant work: the marketplace
   * reader, platform admin, cron jobs. Every call site must justify itself with `reason`
   * so `grep -r runAsPlatform` is a complete audit of the escape hatches.
   *
   * Same await-inside rule as runAsTenant — see the note there.
   */
  async runAsPlatform<T>(reason: string, fn: () => T | Promise<T>): Promise<T> {
    return storage.run({ scope: 'platform', tenantId: null, reason }, async () => await fn());
  },

  /** Pin the already-open scope to a tenant. Used by AccessGuard. */
  bindTenant(tenantId: string): void {
    const store = storage.getStore();
    if (!store) throw new Error('bindTenant() called outside TenantContext.enter()');
    store.scope = 'tenant';
    store.tenantId = tenantId;
    store.reason = undefined;
  },

  /** Widen the already-open scope to platform. Used by AccessGuard for @PlatformScope routes. */
  bindPlatform(reason: string): void {
    const store = storage.getStore();
    if (!store) throw new Error('bindPlatform() called outside TenantContext.enter()');
    store.scope = 'platform';
    store.tenantId = null;
    store.reason = reason;
  },

  current(): TenantStore {
    return storage.getStore() ?? { scope: 'none', tenantId: null };
  },

  /** Throws unless a tenant is pinned. Use in services that must never run platform-wide. */
  requireTenantId(): string {
    const store = storage.getStore();
    if (!store || store.scope !== 'tenant' || !store.tenantId) {
      throw new Error('No tenant in context — this code path requires a bound tenant scope');
    }
    return store.tenantId;
  },
};
