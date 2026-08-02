import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * The job pool: a rider sees the deliveries waiting in their own patch and takes one.
 *
 * Two things are being defended here and neither is about geography.
 *
 * The first is **what an offer does not contain**. Any rider on duty can read this list,
 * so it carries an area name and never a street address or a customer's phone — a list of
 * every doorstep in the village is not something to hand out for the price of flipping a
 * toggle. Those arrive only once the delivery is actually theirs.
 *
 * The second is the **race**. Everyone is looking at the same list, so two riders tapping
 * the same card at the same moment is the ordinary case. Exactly one may win, and the
 * other has to be told, not left believing they have it.
 */
describe('the area job pool', () => {
  const prisma = new PrismaService();
  const ops = new OpsService(prisma, new CacheService(new ConfigService({})), {} as any);

  let shop: string;
  let rakib: string;
  let jashim: string;
  const RAKIB = 'jobpool-rakib-token';
  const JASHIM = 'jobpool-jashim-token';

  /** An unclaimed delivery. `area` is what a village order usually has instead of a pin. */
  const waitingOrder = (code: string, address: Record<string, unknown>) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId: shop,
        code,
        channel: 'OWN_STORE',
        customerPhone: '01799999999',
        status: 'CONFIRMED',
        fulfillment: 'DELIVERY',
        subtotal: 40_000,
        deliveryFee: 6_000,
        total: 46_000,
        dueOnDelivery: 46_000,
        deliveryAddress: address as any,
      },
    });

  const makeRider = (name: string, phone: string, token: string, areas: any[]) =>
    prisma.unsafeRaw.rider.create({
      data: {
        name,
        phone,
        token,
        onDuty: true,
        dutySince: new Date(),
        shops: { create: { tenantId: shop, approved: true, approvedAt: new Date() } },
        areas: { create: areas },
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'village-grocer', name: 'Village Grocer' },
    });
    shop = tenant.id;

    rakib = (await makeRider('Rakib', '01700000101', RAKIB, [
      { label: 'Bazar', shape: { areas: ['Bazar'] } },
    ])).id;
    jashim = (await makeRider('Jashim', '01700000102', JASHIM, [
      { label: 'Bazar', shape: { areas: ['Bazar'] } },
    ])).id;
  });

  afterAll(() => prisma.onModuleDestroy());

  describe('what is offered', () => {
    it('offers a delivery in the rider’s area', async () => {
      await waitingOrder('FHJP001', { area: 'Bazar', addressLine: '12 Mosque Road', phone: '01712345678' });

      const { onDuty, offers } = await ops.availableWork(RAKIB);
      expect(onDuty).toBe(true);
      expect(offers.map((o) => o.code)).toEqual(['FHJP001']);
      expect(offers[0].store).toBe('Village Grocer');
      expect(offers[0].area).toBe('Bazar');
    });

    // The point of the whole endpoint shape. An offer is a decision aid, not an address book.
    it('withholds the street address and the customer’s phone until it is theirs', async () => {
      const { offers } = await ops.availableWork(RAKIB);
      const fields = Object.keys(offers[0]);
      expect(fields).not.toContain('deliveryAddress');
      expect(fields).not.toContain('customerPhone');
      expect(JSON.stringify(offers)).not.toContain('Mosque Road');
      expect(JSON.stringify(offers)).not.toContain('01712345678');
    });

    it('does not offer a delivery outside the rider’s area', async () => {
      await waitingOrder('FHJP002', { area: 'Far Village' });
      const { offers } = await ops.availableWork(RAKIB);
      expect(offers.map((o) => o.code)).not.toContain('FHJP002');
    });

    // An address we cannot read is not quietly given to somebody — it stays with the shop.
    it('does not guess when the address says nothing about where it is', async () => {
      await waitingOrder('FHJP003', { addressLine: 'near the big tree' });
      const { offers } = await ops.availableWork(RAKIB);
      expect(offers.map((o) => o.code)).not.toContain('FHJP003');
    });

    it('offers nothing at all while the rider is off duty', async () => {
      await ops.setDuty(RAKIB, false);
      const { onDuty, offers } = await ops.availableWork(RAKIB);
      expect(onDuty).toBe(false);
      expect(offers).toHaveLength(0);
      await ops.setDuty(RAKIB, true);
    });

    it('drops a delivery off the list once somebody has it', async () => {
      await ops.acceptWork(RAKIB, (await orderId('FHJP001'))!);
      const { offers } = await ops.availableWork(JASHIM);
      expect(offers.map((o) => o.code)).not.toContain('FHJP001');
    });
  });

  describe('two riders, one delivery', () => {
    it('lets exactly one win, and tells the other', async () => {
      const order = await waitingOrder('FHJP010', { area: 'Bazar' });

      const results = await Promise.allSettled([
        ops.acceptWork(RAKIB, order.id),
        ops.acceptWork(JASHIM, order.id),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');

      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      // Not a silent no-op: the loser's phone must say so, or they will stand at the shop
      // waiting for a bag that somebody else already took.
      expect((lost[0] as PromiseRejectedResult).reason.message).toMatch(/taken/i);

      const row = await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } });
      expect([rakib, jashim]).toContain(row!.riderId);
    });

    it('refuses a second claim on a delivery that is already carried', async () => {
      const id = (await orderId('FHJP010'))!;
      await expect(ops.acceptWork(RAKIB, id)).rejects.toThrow();
      await expect(ops.acceptWork(JASHIM, id)).rejects.toThrow();
    });
  });

  describe('passing on a delivery', () => {
    it('hides it from the rider who skipped and leaves it for everyone else', async () => {
      const order = await waitingOrder('FHJP020', { area: 'Bazar' });
      await ops.skipWork(RAKIB, order.id);

      expect((await ops.availableWork(RAKIB)).offers.map((o) => o.code)).not.toContain('FHJP020');
      expect((await ops.availableWork(JASHIM)).offers.map((o) => o.code)).toContain('FHJP020');
    });

    it('is idempotent — a double tap is not an error', async () => {
      const id = (await orderId('FHJP020'))!;
      await expect(ops.skipWork(RAKIB, id)).resolves.toEqual({ ok: true });
    });
  });

  describe('an order that is none of the rider’s business', () => {
    it('cannot be claimed by naming its id', async () => {
      const other = await prisma.unsafeRaw.tenant.create({
        data: { slug: 'other-shop', name: 'Other Shop' },
      });
      const stranger = await prisma.unsafeRaw.order.create({
        data: {
          tenantId: other.id,
          code: 'FHJP099',
          channel: 'OWN_STORE',
          customerPhone: '01700000000',
          status: 'CONFIRMED',
          subtotal: 1000, deliveryFee: 0, total: 1000,
          deliveryAddress: { area: 'Bazar' },
        },
      });

      await expect(ops.acceptWork(RAKIB, stranger.id)).rejects.toThrow();
      await expect(ops.skipWork(RAKIB, stranger.id)).rejects.toThrow();

      const row = await prisma.unsafeRaw.order.findUnique({ where: { id: stranger.id } });
      expect(row!.riderId).toBeNull();
    });
  });

  describe('setting a rider’s patch', () => {
    it('is refused for a rider the shop does not work with', async () => {
      const outsider = await prisma.unsafeRaw.rider.create({
        data: { name: 'Nobody', phone: '01700000199', token: 'outsider-token' },
      });
      await expect(ops.setAreas(shop, outsider.id, [{ label: 'x', shape: {} }])).rejects.toThrow();
    });

    it('replaces the whole list rather than adding to it', async () => {
      await ops.setAreas(shop, rakib, [
        { label: 'North', shape: { areas: ['Uttar Para'] } },
        { label: 'Drawn', shape: { center: { lat: 23.75, lng: 90.38 }, radiusKm: 3 } },
      ]);
      const areas = await ops.listAreas(rakib);
      expect(areas.map((a) => a.label).sort()).toEqual(['Drawn', 'North']);

      // Bazar is gone, so the Bazar order is no longer his.
      const { offers } = await ops.availableWork(RAKIB);
      expect(offers.map((o) => o.code)).not.toContain('FHJP020');
    });

    it('matches a drawn patch by pin', async () => {
      await waitingOrder('FHJP030', { lat: 23.751, lng: 90.381 });
      const { offers } = await ops.availableWork(RAKIB);
      expect(offers.map((o) => o.code)).toContain('FHJP030');
    });
  });

  const orderId = (code: string) =>
    TenantContext.runAsPlatform('test lookup', () =>
      prisma.db.order.findUnique({ where: { code }, select: { id: true } }).then((o) => o?.id),
    );
});
