import { Prisma } from '@prisma/client';
import { TenantContext } from '../common/tenant-context';

/**
 * Models with a NON-NULL `tenantId`. Every query against one of these is either pinned
 * to a tenant or explicitly run in platform scope — there is no third option.
 */
export const TENANT_SCOPED_MODELS = new Set([
  'Domain',
  'Category',
  'Product',
  'Order',
  'Coupon',
  'LedgerEntry',
  'Settlement',
  'Subscription',
  'Invoice',
  'LoyaltyAccount',
  'LoyaltyTransaction',
  'ProductAffinity',
  'Conversation',
]);

/**
 * Models with a NULLABLE `tenantId` (platform rows are legitimate) plus child models
 * reached only through a guarded parent. These are NOT auto-filtered; their services
 * scope them by hand. Listed here so the set is a deliberate decision, not an oversight.
 */
export const UNGUARDED_MODELS = new Set([
  'User', // customers + platform admins have tenantId = null
  'Image', // platform-owned images have tenantId = null
  // A rider is a person who carries for several shops, so there is no single tenantId to
  // filter on — the shops are rows in RiderShop. This is the one model here that is
  // unguarded because of a deliberate design choice rather than a nullable column, and it
  // is the most dangerous of them: a rider's token opens a run sheet showing customers'
  // addresses. Every read in ops.service.ts therefore filters through an approved
  // RiderShop by hand, and rider-isolation.spec.ts is what proves it still does.
  'Rider',
  'RiderShop', // reached via riderId/tenantId, both filtered explicitly at every use
  'RefreshToken', // reached via userId
  'SavedAddress', // reached via userId
  'OrderItem', // reached via orderId, which is guarded
  'OrderEvent',
  'Payment',
  'ConversationMessage', // reached via conversationId, which is guarded
]);

const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Ops whose `where` accepts a unique field plus extra filters (extended where uniqueness). */
const UNIQUE_WHERE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete', 'upsert']);

const WRITE_MANY_OPS = new Set(['updateMany', 'deleteMany']);

export class CrossTenantAccessError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refused ${operation} on ${model}: no tenant in context. ` +
        `Wrap the call in TenantContext.runAsTenant(), or TenantContext.runAsPlatform() if it is genuinely cross-tenant.`,
    );
    this.name = 'CrossTenantAccessError';
  }
}

function mergeWhere(where: unknown, tenantId: string): Record<string, unknown> {
  if (where && typeof where === 'object') {
    return { ...(where as Record<string, unknown>), tenantId };
  }
  return { tenantId };
}

/**
 * Prisma client extension enforcing row-level tenant isolation.
 *
 * One missing filter would leak another vendor's orders — and their encrypted gateway
 * keys — so this is deliberately fail-closed: unknown context throws rather than
 * falling back to "return everything".
 */
export function tenantGuardExtension() {
  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (!TENANT_SCOPED_MODELS.has(model)) return query(args);

          const ctx = TenantContext.current();

          if (ctx.scope === 'platform') return query(args); // audited escape hatch
          if (ctx.scope !== 'tenant' || !ctx.tenantId) {
            throw new CrossTenantAccessError(model, operation);
          }
          const tenantId = ctx.tenantId;

          const a = (args ?? {}) as Record<string, any>;

          if (READ_OPS.has(operation) || WRITE_MANY_OPS.has(operation)) {
            return query({ ...a, where: mergeWhere(a.where, tenantId) });
          }

          if (UNIQUE_WHERE_OPS.has(operation)) {
            // Prisma 5+ extended-where accepts a unique field alongside extra filters,
            // so an update/delete aimed at another tenant simply matches no row (P2025).
            const next: Record<string, any> = { ...a, where: mergeWhere(a.where, tenantId) };
            if (operation === 'upsert') {
              next.create = { ...(a.create ?? {}), tenantId };
            }
            const result = await query(next);
            // Defence in depth: even if a future Prisma drops extended-where silently,
            // a foreign row can never leave this function.
            if (result && typeof result === 'object' && 'tenantId' in (result as any)) {
              if ((result as any).tenantId !== tenantId) {
                throw new CrossTenantAccessError(model, operation);
              }
            }
            return result;
          }

          if (operation === 'create') {
            return query({ ...a, data: { ...(a.data ?? {}), tenantId } });
          }

          if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const data = Array.isArray(a.data) ? a.data : [a.data];
            return query({ ...a, data: data.map((d: any) => ({ ...d, tenantId })) });
          }

          // Anything unrecognised (new Prisma op) is refused rather than waved through.
          throw new CrossTenantAccessError(model, operation);
        },
      },
    },
  });
}
