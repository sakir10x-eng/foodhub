import {
  CUSTOMER_CANCELLABLE_STATUSES,
  canCustomerCancel,
  estimateEta,
  etaClock,
  formatEta,
  normaliseCuisine,
  type OrderStatus,
} from '@foodhub/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { OrdersService } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * The quoted arrival window.
 *
 * Two things must hold, and both are promises to a customer rather than arithmetic:
 * the window can never be shorter than the vendor's own estimate, and it is always a
 * range — a single number is a promise that a normal delivery breaks.
 */
describe('delivery ETA', () => {
  it('adds the rider leg to the kitchen, as a range', () => {
    const eta = estimateEta({ prepMinutes: 25, deliveryMinutes: 20 });
    expect(eta.min).toBe(45);
    expect(eta.max).toBe(55);
  });

  it('quotes only the counter wait when the customer is collecting', () => {
    const eta = estimateEta({ prepMinutes: 40, deliveryMinutes: 30, pickupMinutes: 15, fulfillment: 'PICKUP' });
    // The rider leg is not part of a collection, so neither is its 30 minutes.
    expect(eta.min).toBe(15);
    expect(eta.max).toBe(20);
  });

  it('never quotes LESS than the vendor said because the customer is nearby', () => {
    const far = estimateEta({ prepMinutes: 20, deliveryMinutes: 20, distanceKm: 8 });
    const near = estimateEta({ prepMinutes: 20, deliveryMinutes: 20, distanceKm: 0.2 });
    // The vendor's own number already covers the counter wait, the lift and the gate.
    expect(near.min).toBe(40);
    expect(far.min).toBeGreaterThan(near.min);
  });

  it('ignores a distance that cannot be true', () => {
    for (const distanceKm of [0, -5, Number.NaN, null, undefined]) {
      expect(estimateEta({ prepMinutes: 20, deliveryMinutes: 20, distanceKm }).min).toBe(40);
    }
  });

  it('rounds up to five minutes so the quote reads as an estimate', () => {
    expect(estimateEta({ prepMinutes: 11, deliveryMinutes: 12 }).min).toBe(25);
  });

  it('turns the window into clock times counted from a real instant', () => {
    const from = new Date('2026-07-31T10:00:00.000Z');
    const { earliest, latest } = etaClock(from, { min: 30, max: 40 });
    expect(earliest.toISOString()).toBe('2026-07-31T10:30:00.000Z');
    expect(latest.toISOString()).toBe('2026-07-31T10:40:00.000Z');
  });

  it('writes the window in the reader’s own digits', () => {
    expect(formatEta({ min: 30, max: 40 }, 'en')).toBe('30–40 min');
    expect(formatEta({ min: 30, max: 40 }, 'bn')).toBe('৩০–৪০ মিনিট');
  });
});

describe('cuisine tags', () => {
  it('folds a vendor’s capitalisation into the suggested tag', () => {
    expect(normaliseCuisine('fast  food')).toBe('Fast Food');
    expect(normaliseCuisine('  BIRYANI ')).toBe('Biryani');
  });

  it('keeps a tag we have never heard of', () => {
    expect(normaliseCuisine('  Afghani ')).toBe('Afghani');
  });
});

/**
 * Who may cancel, and when.
 *
 * The line is the kitchen: a customer may call off an order the vendor has not started
 * cooking, and no later. A vendor may still cancel afterwards — that is them choosing to
 * absorb the cost, which is a different decision entirely.
 */
describe('customer cancellation', () => {
  const prisma = new PrismaService();
  const orders = new OrdersService(
    prisma,
    new LedgerService(prisma),
    new LoyaltyService(prisma),
    // The queue and the realtime gateway are fire-and-forget notifications; a cancelled
    // order is cancelled whether or not the SMS goes out.
    { enqueue: async () => undefined } as any,
    { emitOrderUpdate: () => undefined, emitNewOrder: () => undefined } as any,
    { settleOnDelivery: async () => undefined } as any,
  );

  let tenantId: string;
  const PHONE = '01711223344';

  const makeOrder = (status: OrderStatus, over: Record<string, any> = {}) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId,
        code: `FH${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        channel: 'OWN_STORE',
        customerPhone: PHONE,
        status,
        subtotal: 100_000,
        deliveryFee: 6_000,
        total: 106_000,
        commissionAmount: 0,
        deliveryAddress: {},
        ...over,
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();
    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'cancel-test', name: 'Cancel Test', phone: '01799000000' },
    });
    tenantId = tenant.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('agrees with the shared rule about which statuses are cancellable', () => {
    expect([...CUSTOMER_CANCELLABLE_STATUSES]).toEqual(['PENDING', 'CONFIRMED']);
    expect(canCustomerCancel('PREPARING')).toBe(false);
  });

  it('cancels an order the kitchen has not started', async () => {
    const order = await makeOrder('CONFIRMED');
    const result = await TenantContext.runAsTenant(tenantId, () =>
      orders.cancelByCustomer(order.code, PHONE, 'Ordered by mistake'),
    );
    expect(result.status).toBe('CANCELLED');
    expect(result.canCancel).toBe(false);
  });

  it('refuses once the food is being cooked, and says who to call', async () => {
    const order = await makeOrder('PREPARING');
    await expect(
      TenantContext.runAsTenant(tenantId, () => orders.cancelByCustomer(order.code, PHONE)),
    ).rejects.toThrow(/01799000000/);
  });

  it('refuses a phone that did not place the order', async () => {
    const order = await makeOrder('PENDING');
    await expect(
      TenantContext.runAsTenant(tenantId, () => orders.cancelByCustomer(order.code, '01999999999')),
    ).rejects.toThrow(/No order found/);
  });

  it('matches on the last ten digits, so +880 and 0 are the same person', async () => {
    const order = await makeOrder('PENDING');
    const result = await TenantContext.runAsTenant(tenantId, () =>
      orders.cancelByCustomer(order.code, '+8801711223344'),
    );
    expect(result.status).toBe('CANCELLED');
  });

  it('will not cancel the same order twice', async () => {
    const order = await makeOrder('PENDING');
    await TenantContext.runAsTenant(tenantId, () => orders.cancelByCustomer(order.code, PHONE));
    await expect(
      TenantContext.runAsTenant(tenantId, () => orders.cancelByCustomer(order.code, PHONE)),
    ).rejects.toThrow(/already cancelled/i);
  });
});
