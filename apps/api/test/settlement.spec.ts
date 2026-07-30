import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { SettlementsService } from '../src/settlements/settlements.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Marketplace money. Two things must hold no matter what:
 *   - an own_store order NEVER produces a ledger row (we don't touch that money)
 *   - a delivered order settles exactly once, however many times DELIVERED fires
 */
describe('ledger and settlement', () => {
  const prisma = new PrismaService();
  const ledger = new LedgerService(prisma);
  const settlements = new SettlementsService(prisma, new ConfigService({}));

  let tenantId: string;

  const makeOrder = (over: Partial<Record<string, any>> = {}) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId,
        code: `FH${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        channel: 'MARKETPLACE',
        customerPhone: '01711111111',
        subtotal: 100_000,
        deliveryFee: 6_000,
        total: 106_000,
        commissionAmount: 15_000,
        gatewayFee: 2_650,
        paymentStatus: 'PAID',
        deliveryAddress: {},
        ...over,
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();
    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'ledger-test', name: 'Ledger Test', commissionRateBps: 1500 },
    });
    tenantId = tenant.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('books gross, commission and payable on delivery', async () => {
    const order = await makeOrder();

    await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => ledger.postOrderDelivered(tx, order)),
    );

    const entries = await prisma.unsafeRaw.ledgerEntry.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries.map((e) => e.type)).toEqual(['CUSTOMER_PAYMENT', 'COMMISSION', 'VENDOR_PAYABLE']);
    expect(entries[0].amount).toBe(106_000);
    expect(entries[1].amount).toBe(-(15_000 + 2_650));
    expect(entries[2].amount).toBe(106_000 - 15_000 - 2_650);

    // The running balance tracks what we owe the vendor, so the memo rows must not move it.
    expect(entries[0].balanceAfter).toBe(0);
    expect(entries[1].balanceAfter).toBe(0);
    expect(entries[2].balanceAfter).toBe(88_350);
  });

  /**
   * Regression: Postgres now() is transaction-scoped, so the three rows written by
   * postOrderDelivered all share a createdAt. Reading "the latest balance" by timestamp
   * used to pick a memo row at random, which double-counted the previous order's payable
   * into the next one. The running balance must follow the write sequence, not the clock.
   */
  it('carries the running balance forward correctly across consecutive orders', async () => {
    const second = await makeOrder();
    await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => ledger.postOrderDelivered(tx, second)),
    );

    const payable = await prisma.unsafeRaw.ledgerEntry.findFirst({
      where: { orderId: second.id, type: 'VENDOR_PAYABLE' },
    });
    // Two delivered orders at 88,350 each — not 88,350 + a memo row's balance.
    expect(payable!.balanceAfter).toBe(88_350 * 2);

    const unsettled = await TenantContext.runAsTenant(tenantId, () => ledger.unsettledPayable(tenantId));
    expect(unsettled).toBe(88_350 * 2);

    // Leave the fixture as the later tests expect it.
    await prisma.unsafeRaw.ledgerEntry.deleteMany({ where: { orderId: second.id } });
    await prisma.unsafeRaw.order.delete({ where: { id: second.id } });
  });

  it('treats a cash order as a receivable, not a payout', async () => {
    const order = await makeOrder({ paymentStatus: 'UNPAID', gatewayFee: 0 });

    const before = await TenantContext.runAsTenant(tenantId, () => ledger.unsettledPayable(tenantId));
    await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => ledger.postCodCommissionDue(tx, order)),
    );
    const after = await TenantContext.runAsTenant(tenantId, () => ledger.unsettledPayable(tenantId));

    // The vendor collected the cash, so our commission reduces what we owe them.
    expect(before).toBe(88_350);
    expect(after).toBe(88_350 - 15_000);
    const payable = await prisma.unsafeRaw.ledgerEntry.findFirst({
      where: { orderId: order.id, type: 'VENDOR_PAYABLE' },
    });
    expect(payable!.amount).toBe(-15_000);
  });

  /**
   * The advance-payment case: we hold half the money, the rider took the other half in
   * cash. Both the payable and the commission have to come out of OUR half only —
   * booking the full total would credit the vendor for cash they are already holding.
   */
  it('settles a part-paid order against only the money we collected', async () => {
    const order = await makeOrder({
      paymentStatus: 'PARTIALLY_PAID',
      advanceAmount: 53_000,
      dueOnDelivery: 53_000,
      gatewayFee: 1_325, // the gateway only processed the advance, so its fee halves too
    });

    const before = await TenantContext.runAsTenant(tenantId, () => ledger.unsettledPayable(tenantId));
    await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => ledger.postOrderSettlement(tx, order, order.advanceAmount)),
    );
    const after = await TenantContext.runAsTenant(tenantId, () => ledger.unsettledPayable(tenantId));

    const entries = await prisma.unsafeRaw.ledgerEntry.findMany({
      where: { orderId: order.id },
      orderBy: { seq: 'asc' },
    });

    expect(entries.map((e) => e.type)).toEqual(['CUSTOMER_PAYMENT', 'COMMISSION', 'VENDOR_PAYABLE']);
    // Gross reflects the advance, not the order total — the rest never reached us.
    expect(entries[0].amount).toBe(53_000);
    expect(entries[2].amount).toBe(53_000 - 15_000 - 1_325);
    expect(after - before).toBe(53_000 - 15_000 - 1_325);

    await prisma.unsafeRaw.ledgerEntry.deleteMany({ where: { orderId: order.id } });
    await prisma.unsafeRaw.order.delete({ where: { id: order.id } });
  });

  /**
   * Regression guard on the unification: the two hand-written branches this replaced must
   * still produce exactly what they used to, or every historical statement stops adding up.
   */
  it('reproduces both extremes from the single settlement formula', async () => {
    const prepaid = await makeOrder();
    const cash = await makeOrder({ paymentStatus: 'UNPAID', gatewayFee: 0 });

    const [full, none] = await TenantContext.runAsTenant(tenantId, async () => [
      await prisma.db.$transaction((tx) => ledger.postOrderSettlement(tx, prepaid, prepaid.total)),
      await prisma.db.$transaction((tx) => ledger.postOrderSettlement(tx, cash, 0)),
    ]);

    expect(full.vendorPayable).toBe(106_000 - 15_000 - 2_650); // we owe them
    expect(none.vendorPayable).toBe(-15_000); // they owe us

    for (const o of [prepaid, cash]) {
      await prisma.unsafeRaw.ledgerEntry.deleteMany({ where: { orderId: o.id } });
      await prisma.unsafeRaw.order.delete({ where: { id: o.id } });
    }
  });

  it('rolls unsettled entries into one settlement and zeroes the balance', async () => {
    const start = new Date(Date.now() - 7 * 86_400_000);
    const end = new Date(Date.now() + 60_000);

    const settlement = await settlements.settleTenant(tenantId, start, end);
    expect(settlement).not.toBeNull();
    // 88,350 payable from the paid order, minus 15,000 commission owed on the cash order.
    expect(settlement!.netPayable).toBe(88_350 - 15_000);

    const remaining = await TenantContext.runAsTenant(tenantId, () => ledger.unsettledPayable(tenantId));
    expect(remaining).toBe(0);

    const closing = await prisma.unsafeRaw.ledgerEntry.findFirst({
      where: { tenantId, type: 'SETTLEMENT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(closing!.balanceAfter).toBe(0);
  });

  it('is idempotent — a second run finds nothing left to claim', async () => {
    const again = await settlements.settleTenant(
      tenantId,
      new Date(Date.now() - 7 * 86_400_000),
      new Date(Date.now() + 60_000),
    );
    expect(again).toBeNull();
  });

  it('never writes a ledger row for an own_store order', async () => {
    const order = await makeOrder({ channel: 'OWN_STORE', commissionAmount: 0, gatewayFee: 0 });
    const entries = await prisma.unsafeRaw.ledgerEntry.count({ where: { orderId: order.id } });
    expect(entries).toBe(0);
  });
});
