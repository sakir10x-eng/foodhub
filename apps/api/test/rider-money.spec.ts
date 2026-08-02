import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { RiderLedgerService, overCashLimit } from '../src/rider-ledger/rider-ledger.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { OrdersService } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * A rider's money.
 *
 * Cash on delivery is the largest operational risk in this product: at the end of a day a
 * rider is carrying several thousand taka of somebody else's money, and until now nothing
 * anywhere recorded how much. Three things are defended here.
 *
 *   1. **The two books stay apart.** Cash in hand is the shop's; earnings are the rider's.
 *      Merged, "৳500 not handed in" and "৳500 of wages owed" are the same number.
 *   2. **A replayed DELIVERED must not pay twice.** It fires on retries and double taps.
 *   3. **A shortfall is never silently turned into a penalty.** Software that quietly docks
 *      a worker's pay to balance its own arithmetic is not doing accounting.
 */
describe('a rider’s two books', () => {
  const prisma = new PrismaService();
  const riderLedger = new RiderLedgerService(prisma);
  const orders = new OrdersService(
    prisma,
    new LedgerService(prisma),
    riderLedger,
    new LoyaltyService(prisma),
    { enqueue: async () => undefined } as any,
    { emitOrderUpdate: () => undefined, emitNewOrder: () => undefined } as any,
    { settleOnDelivery: async () => undefined } as any,
  );
  const ops = new OpsService(prisma, new CacheService(new ConfigService({})), orders, riderLedger);

  let shop: string;
  let riderId: string;
  const TOKEN = 'money-rider-token';
  const FEE = 3_000; // ৳30, the default

  const orderFor = (code: string, dueOnDelivery: number) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId: shop, code,
        channel: 'OWN_STORE',
        customerPhone: '01788888888',
        status: 'READY',
        fulfillment: 'DELIVERY',
        riderId,
        subtotal: 40_000, deliveryFee: 5_000, total: 45_000,
        advanceAmount: 45_000 - dueOnDelivery,
        dueOnDelivery,
        deliveryAddress: { area: 'Bazar' } as any,
      },
    });

  /** Walk an order down the legal happy path from wherever it currently is. */
  const deliver = (id: string) =>
    TenantContext.runAsTenant(shop, async () => {
      const path = ['CONFIRMED', 'PREPARING', 'READY', 'ON_THE_WAY', 'DELIVERED'] as const;
      const now = await prisma.db.order.findUnique({ where: { id }, select: { status: true } });
      const from = path.indexOf(now!.status as any);
      for (const next of path.slice(from + 1)) await orders.updateStatus(id, next, 'test');
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'money-shop', name: 'Money Shop' },
    });
    shop = tenant.id;

    const rider = await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Karim', phone: '01700000501', token: TOKEN,
        onDuty: true, dutySince: new Date(),
        shops: { create: { tenantId: shop, approved: true, approvedAt: new Date() } },
        areas: { create: [{ label: 'Bazar', shape: { areas: ['Bazar'] } as any }] },
      },
    });
    riderId = rider.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('starts at nothing', async () => {
    expect(await riderLedger.balances(riderId)).toEqual({ cash: 0, earnings: 0 });
  });

  it('adds the cash to one book and the fee to the other', async () => {
    const order = await orderFor('FHMN001', 45_000);
    await deliver(order.id);

    expect(await riderLedger.balances(riderId)).toEqual({ cash: 45_000, earnings: FEE });
  });

  // DELIVERED fires again on a retried webhook or a double tap. The unique index on
  // (orderId, type) is what makes that harmless.
  it('does not pay twice when DELIVERED is replayed', async () => {
    const order = await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHMN001' } });
    await TenantContext.runAsTenant(shop, () => orders.updateStatus(order!.id, 'DELIVERED', 'test'));

    expect(await riderLedger.balances(riderId)).toEqual({ cash: 45_000, earnings: FEE });
  });

  it('pays the fee but takes no cash on an order that was already paid for', async () => {
    const order = await orderFor('FHMN002', 0);
    await deliver(order.id);

    // Nothing to collect, so no cash row exists at all — a zero entry would be a lie
    // dressed as a record.
    expect(await riderLedger.balances(riderId)).toEqual({ cash: 45_000, earnings: FEE * 2 });
    const cashRows = await prisma.unsafeRaw.riderLedgerEntry.findMany({
      where: { riderId, account: 'CASH' },
    });
    expect(cashRows).toHaveLength(1);
  });

  it('carries a running balance in write order, not timestamp order', async () => {
    const order = await orderFor('FHMN003', 20_000);
    await deliver(order.id);

    const cash = await prisma.unsafeRaw.riderLedgerEntry.findMany({
      where: { riderId, account: 'CASH' },
      orderBy: { seq: 'asc' },
    });
    expect(cash.map((r) => r.balanceAfter)).toEqual([45_000, 65_000]);
  });

  describe('handing the cash in', () => {
    it('refuses more than the rider is carrying', async () => {
      await expect(riderLedger.deposit(shop, riderId, 999_999, 'vendor:test')).rejects.toThrow(/carrying/i);
    });

    it('takes a part payment and leaves the rest visible as still held', async () => {
      const after = await riderLedger.deposit(shop, riderId, 40_000, 'vendor:test', 'Evening hand-in');
      // Not rounded off, not written off, not deducted from wages. Just still owed.
      expect(after.cash).toBe(25_000);
      expect(after.earnings).toBe(FEE * 3);
    });

    it('reaches zero when the rest comes in', async () => {
      const after = await riderLedger.deposit(shop, riderId, 25_000, 'vendor:test');
      expect(after.cash).toBe(0);
    });
  });

  describe('paying the rider', () => {
    it('refuses an adjustment with no reason attached', async () => {
      await expect(
        riderLedger.settleEarnings(shop, riderId, 5_000, 'ADJUSTMENT', 'vendor:test'),
      ).rejects.toThrow(/why/i);
    });

    it('records a bonus with its reason', async () => {
      const after = await riderLedger.settleEarnings(
        shop, riderId, 5_000, 'ADJUSTMENT', 'vendor:test', 'Rain bonus',
      );
      expect(after.earnings).toBe(FEE * 3 + 5_000);
    });

    it('pays out and leaves the cash book untouched', async () => {
      const after = await riderLedger.settleEarnings(shop, riderId, 14_000, 'PAYOUT', 'vendor:test');
      expect(after.earnings).toBe(0);
      expect(after.cash).toBe(0);
    });
  });

  describe('the cash ceiling', () => {
    it('is a limit on what is held, not on the rider', () => {
      expect(overCashLimit(499_999, 500_000)).toBe(false);
      expect(overCashLimit(500_000, 500_000)).toBe(true);
      // Zero disables it rather than blocking everything, which is the safer reading of
      // an unset field.
      expect(overCashLimit(999_999, 0)).toBe(false);
    });

    it('stops offering cash work once the rider is at the ceiling — and only cash work', async () => {
      await prisma.unsafeRaw.tenant.update({ where: { id: shop }, data: { riderCashLimit: 10_000 } });

      const cod = await prisma.unsafeRaw.order.create({
        data: {
          tenantId: shop, code: 'FHMN010', channel: 'OWN_STORE', customerPhone: '01788888888',
          status: 'CONFIRMED', fulfillment: 'DELIVERY',
          subtotal: 10_000, deliveryFee: 0, total: 10_000, dueOnDelivery: 10_000,
          deliveryAddress: { area: 'Bazar' } as any,
        },
      });
      const prepaid = await prisma.unsafeRaw.order.create({
        data: {
          tenantId: shop, code: 'FHMN011', channel: 'OWN_STORE', customerPhone: '01788888888',
          status: 'CONFIRMED', fulfillment: 'DELIVERY',
          subtotal: 10_000, deliveryFee: 0, total: 10_000,
          advanceAmount: 10_000, dueOnDelivery: 0,
          deliveryAddress: { area: 'Bazar' } as any,
        },
      });

      // Under the ceiling: both are offered.
      let offers = (await ops.availableWork(TOKEN)).offers.map((o) => o.code);
      expect(offers).toEqual(expect.arrayContaining(['FHMN010', 'FHMN011']));

      // Put them over it.
      await ops.acceptWork(TOKEN, cod.id);
      await deliver(cod.id);
      expect((await riderLedger.balances(riderId)).cash).toBe(10_000);

      offers = (await ops.availableWork(TOKEN)).offers.map((o) => o.code);
      expect(offers).not.toContain('FHMN010');
      // The prepaid one survives: the exposure being managed is the money on them, and
      // stopping their whole day would be a punishment rather than a control.
      expect(offers).toContain('FHMN011');
    });
  });

  describe('what each side can see', () => {
  it('shows the rider their own position', async () => {
    const money = await ops.riderMoney(TOKEN);
    expect(money.cash).toBe(10_000);
    expect(money.recent.length).toBeGreaterThan(0);
    // Newest first, so the last thing that happened is the first thing they see.
    expect(money.recent[0].seq).toBeGreaterThan(money.recent[money.recent.length - 1].seq);
  });

  it('shows the shop who is carrying what', async () => {
    const overview = await riderLedger.shopOverview(shop);
    expect(overview).toHaveLength(1);
    expect(overview[0]).toMatchObject({ name: 'Karim', cash: 10_000 });
  });
  });
});
