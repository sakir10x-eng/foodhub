import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * A rider's `token` is a working delivery link.
 *
 * Anyone holding it can open the run sheet and read every customer that rider is
 * carrying: full address, phone number, and the exact cash to be handed over at the door.
 * That makes the rider list a more dangerous thing to leak than the order list, and it is
 * why these tests exist as their own file rather than as three more cases in
 * tenant-isolation.spec.ts.
 *
 * All three vectors below were genuinely open: `Rider` was in neither of the guard's two
 * model sets, so its queries were passed through unfiltered, and `listRiders` accepted a
 * `tenantId` it never used.
 */
describe('rider isolation between shops', () => {
  const prisma = new PrismaService();
  const ops = new OpsService(prisma, new CacheService(new ConfigService({})));

  let alpha: string;
  let beta: string;
  let alphaRider: string;
  let betaRider: string;
  let alphaOrder: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const [a, b] = await Promise.all([
      prisma.unsafeRaw.tenant.create({ data: { slug: 'alpha-kitchen', name: 'Alpha Kitchen' } }),
      prisma.unsafeRaw.tenant.create({ data: { slug: 'beta-grocers', name: 'Beta Grocers' } }),
    ]);
    alpha = a.id;
    beta = b.id;

    const [ar, br] = await Promise.all([
      prisma.unsafeRaw.rider.create({
        data: { tenantId: alpha, name: 'Rakib', phone: '01700000011', token: 'alpha-rider-token' },
      }),
      prisma.unsafeRaw.rider.create({
        data: { tenantId: beta, name: 'Jashim', phone: '01700000022', token: 'beta-rider-token' },
      }),
    ]);
    alphaRider = ar.id;
    betaRider = br.id;

    const order = await prisma.unsafeRaw.order.create({
      data: {
        tenantId: alpha,
        code: 'FHISO001',
        channel: 'OWN_STORE',
        customerPhone: '01711111111',
        status: 'READY',
        subtotal: 20_000,
        deliveryFee: 6_000,
        total: 26_000,
        deliveryAddress: {},
      },
    });
    alphaOrder = order.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  describe('the guard itself', () => {
    it('refuses an unscoped rider read rather than returning every shop’s riders', async () => {
      await expect(prisma.db.rider.findMany()).rejects.toThrow();
    });

    it('returns only the bound shop’s riders', async () => {
      const rows = await TenantContext.runAsTenant(alpha, () => prisma.db.rider.findMany());
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Rakib');
    });

    // The rider run sheet resolves its own tenant from the token, so this escape hatch has
    // to keep working — it is the one legitimate cross-tenant rider read.
    it('still allows the audited platform-scope lookup the run sheet needs', async () => {
      const found = await TenantContext.runAsPlatform('test: run sheet resolves its own tenant', () =>
        prisma.db.rider.findUnique({ where: { token: 'beta-rider-token' } }),
      );
      expect(found?.name).toBe('Jashim');
    });
  });

  describe('vector 1 — listing riders', () => {
    it('never returns another shop’s rider, and never their token', async () => {
      const riders = await TenantContext.runAsTenant(alpha, () => ops.listRiders(alpha));
      expect(riders).toHaveLength(1);
      expect(riders[0].name).toBe('Rakib');
      expect(riders.map((r) => r.token)).not.toContain('beta-rider-token');
    });
  });

  describe('vector 2 — deactivating a rider', () => {
    it('refuses to switch off a rider belonging to another shop', async () => {
      await expect(
        TenantContext.runAsTenant(alpha, () => ops.removeRider(alpha, betaRider)),
      ).rejects.toThrow();

      const untouched = await prisma.unsafeRaw.rider.findUnique({ where: { id: betaRider } });
      expect(untouched!.isActive).toBe(true);
    });

    it('still deactivates the shop’s own rider', async () => {
      await TenantContext.runAsTenant(alpha, () => ops.removeRider(alpha, alphaRider));
      const own = await prisma.unsafeRaw.rider.findUnique({ where: { id: alphaRider } });
      expect(own!.isActive).toBe(false);

      // put it back — the assignment cases below need a live rider
      await prisma.unsafeRaw.rider.update({ where: { id: alphaRider }, data: { isActive: true } });
    });
  });

  describe('vector 3 — assigning a rider to an order', () => {
    it('refuses another shop’s rider, and leaves the order unassigned', async () => {
      await expect(
        TenantContext.runAsTenant(alpha, () => ops.assignRider(alphaOrder, betaRider)),
      ).rejects.toThrow();

      const order = await prisma.unsafeRaw.order.findUnique({ where: { id: alphaOrder } });
      expect(order!.riderId).toBeNull();
    });

    it('refuses a rider that has been deactivated', async () => {
      await prisma.unsafeRaw.rider.update({ where: { id: alphaRider }, data: { isActive: false } });
      await expect(
        TenantContext.runAsTenant(alpha, () => ops.assignRider(alphaOrder, alphaRider)),
      ).rejects.toThrow();
      await prisma.unsafeRaw.rider.update({ where: { id: alphaRider }, data: { isActive: true } });
    });

    it('assigns the shop’s own rider, and can still unassign', async () => {
      await TenantContext.runAsTenant(alpha, () => ops.assignRider(alphaOrder, alphaRider));
      let order = await prisma.unsafeRaw.order.findUnique({ where: { id: alphaOrder } });
      expect(order!.riderId).toBe(alphaRider);

      // null is not an id to validate — it is the vendor taking the rider back off.
      await TenantContext.runAsTenant(alpha, () => ops.assignRider(alphaOrder, null));
      order = await prisma.unsafeRaw.order.findUnique({ where: { id: alphaOrder } });
      expect(order!.riderId).toBeNull();
    });
  });

  describe('the run sheet still works', () => {
    it('shows a rider their own shop’s deliveries', async () => {
      await prisma.unsafeRaw.order.update({
        where: { id: alphaOrder },
        data: { riderId: alphaRider, status: 'ON_THE_WAY' },
      });

      const queue = await ops.riderQueue('alpha-rider-token');
      expect(queue.rider).toEqual({ name: 'Rakib', store: 'Alpha Kitchen' });
      expect(queue.orders.map((o) => o.code)).toEqual(['FHISO001']);
    });

    it('shows a rider from another shop nothing of ours', async () => {
      const queue = await ops.riderQueue('beta-rider-token');
      expect(queue.orders).toHaveLength(0);
    });
  });
});
