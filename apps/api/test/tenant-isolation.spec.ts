import { PrismaService } from '../src/prisma/prisma.service';
import { TenantContext } from '../src/common/tenant-context';
import { CrossTenantAccessError } from '../src/prisma/tenant-guard';

/**
 * tenant_id isolation is the single security-critical invariant in this codebase: one
 * missing filter leaks another vendor's orders, customers and encrypted gateway keys.
 *
 * These tests attack the guard directly rather than through HTTP, because the guard is
 * what has to hold even when a future controller forgets its `where` clause.
 */
describe('tenant isolation', () => {
  const prisma = new PrismaService();

  let alpha: string;
  let beta: string;
  let alphaProduct: string;
  let betaProduct: string;
  let betaOrder: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const [a, b] = await Promise.all([
      prisma.unsafeRaw.tenant.create({ data: { slug: 'alpha-foods', name: 'Alpha Foods' } }),
      prisma.unsafeRaw.tenant.create({ data: { slug: 'beta-bites', name: 'Beta Bites' } }),
    ]);
    alpha = a.id;
    beta = b.id;

    const [ap, bp] = await Promise.all([
      prisma.unsafeRaw.product.create({ data: { tenantId: alpha, name: 'Alpha Burger', price: 30_000 } }),
      prisma.unsafeRaw.product.create({ data: { tenantId: beta, name: 'Beta Roll', price: 20_000 } }),
    ]);
    alphaProduct = ap.id;
    betaProduct = bp.id;

    const order = await prisma.unsafeRaw.order.create({
      data: {
        tenantId: beta,
        code: 'FHTEST1',
        channel: 'MARKETPLACE',
        customerPhone: '01711111111',
        subtotal: 20_000,
        deliveryFee: 6_000,
        total: 26_000,
        deliveryAddress: {},
      },
    });
    betaOrder = order.id;
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  describe('with no scope bound', () => {
    it('refuses reads rather than returning everything', async () => {
      await expect(prisma.db.product.findMany()).rejects.toThrow(CrossTenantAccessError);
    });

    it('refuses writes', async () => {
      await expect(
        prisma.db.product.create({ data: { tenantId: alpha, name: 'x', price: 1 } as any }),
      ).rejects.toThrow(CrossTenantAccessError);
    });

    // Fail-closed is the whole point: an unscoped query is a bug, and a bug must be a
    // 500 in our logs, never a silent cross-tenant read.
    it('refuses counts and aggregates', async () => {
      await expect(prisma.db.order.count()).rejects.toThrow(CrossTenantAccessError);
      await expect(prisma.db.ledgerEntry.aggregate({ _sum: { amount: true } })).rejects.toThrow(
        CrossTenantAccessError,
      );
    });
  });

  describe('bound to one tenant', () => {
    it('findMany returns only that tenant’s rows', async () => {
      const rows = await TenantContext.runAsTenant(alpha, () => prisma.db.product.findMany());
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Alpha Burger');
    });

    it('findUnique cannot reach across tenants', async () => {
      const stolen = await TenantContext.runAsTenant(alpha, () =>
        prisma.db.product.findUnique({ where: { id: betaProduct } }),
      );
      expect(stolen).toBeNull();
    });

    it('update cannot reach across tenants', async () => {
      await expect(
        TenantContext.runAsTenant(alpha, () =>
          prisma.db.product.update({ where: { id: betaProduct }, data: { price: 1 } }),
        ),
      ).rejects.toThrow();

      const untouched = await prisma.unsafeRaw.product.findUnique({ where: { id: betaProduct } });
      expect(untouched!.price).toBe(20_000);
    });

    it('delete cannot reach across tenants', async () => {
      await expect(
        TenantContext.runAsTenant(alpha, () => prisma.db.product.delete({ where: { id: betaProduct } })),
      ).rejects.toThrow();
      expect(await prisma.unsafeRaw.product.count({ where: { id: betaProduct } })).toBe(1);
    });

    it('deleteMany cannot empty another tenant’s catalogue', async () => {
      const result = await TenantContext.runAsTenant(alpha, () =>
        prisma.db.product.deleteMany({ where: { price: { gt: 0 } } }),
      );
      expect(result.count).toBe(1); // only Alpha's own product
      expect(await prisma.unsafeRaw.product.count({ where: { tenantId: beta } })).toBe(1);

      // put Alpha's product back for the remaining tests
      const restored = await prisma.unsafeRaw.product.create({
        data: { tenantId: alpha, name: 'Alpha Burger', price: 30_000 },
      });
      alphaProduct = restored.id;
    });

    it('create is forced onto the bound tenant even if the payload lies', async () => {
      const created = await TenantContext.runAsTenant(alpha, () =>
        prisma.db.product.create({
          data: { tenantId: beta, name: 'Smuggled', price: 100 } as any,
        }),
      );
      expect(created.tenantId).toBe(alpha);
      await prisma.unsafeRaw.product.delete({ where: { id: created.id } });
    });

    it('orders are invisible across tenants', async () => {
      const found = await TenantContext.runAsTenant(alpha, () =>
        prisma.db.order.findUnique({ where: { id: betaOrder } }),
      );
      expect(found).toBeNull();

      const count = await TenantContext.runAsTenant(alpha, () => prisma.db.order.count());
      expect(count).toBe(0);
    });

    it('holds inside a transaction', async () => {
      const rows = await TenantContext.runAsTenant(alpha, () =>
        prisma.db.$transaction(async (tx) => {
          const products = await tx.product.findMany();
          const orders = await tx.order.findMany();
          return { products: products.length, orders: orders.length };
        }),
      );
      expect(rows).toEqual({ products: 1, orders: 0 });
    });

    // Prisma promises are lazy: a scope helper that returns the promise without awaiting
    // it would exit before the query ran, and the guard would see no context at all.
    it('holds when the scope helper is given a non-async callback', async () => {
      const rows = await TenantContext.runAsTenant(beta, () => prisma.db.product.findMany());
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Beta Roll');
    });
  });

  describe('platform scope', () => {
    it('reads across tenants when explicitly asked to', async () => {
      const rows = await TenantContext.runAsPlatform('test: marketplace-style read', () =>
        prisma.db.product.findMany(),
      );
      expect(rows.length).toBe(2);
    });

    it('does not leak back into the surrounding scope', async () => {
      await TenantContext.runAsTenant(alpha, async () => {
        await TenantContext.runAsPlatform('test: nested', () => prisma.db.product.findMany());
        const rows = await prisma.db.product.findMany();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(alphaProduct);
      });
    });
  });

  describe('models the guard deliberately does not filter', () => {
    // User and Image carry a NULLABLE tenantId (platform admins, customers, platform
    // images are legitimate rows), so they are scoped by hand in their services. This
    // test pins that decision so nobody "fixes" it by accident.
    it('allows unscoped user reads', async () => {
      await expect(prisma.db.user.findMany()).resolves.toBeDefined();
    });
  });
});
