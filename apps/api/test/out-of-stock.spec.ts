import { ConfigService } from '@nestjs/config';
import { isReductionOnly, repriceOrder } from '@foodhub/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { RiderLedgerService } from '../src/rider-ledger/rider-ledger.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { OrdersService } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * "We have run out of this."
 *
 * A grocer runs out daily, in the middle of packing, and without a way to handle it the
 * only option is cancelling an order somebody is waiting for. This is a money path, so
 * every rule here is a refusal: only downwards, only before the rider has the bag, prices
 * from the snapshots, and an overpayment surfaced rather than netted away.
 */

describe('repricing arithmetic', () => {
  const base = { subtotal: 100_00, discount: 10_00, deliveryFee: 5_00, advanceAmount: 0 };

  it('charges only for what was supplied', () => {
    const out = repriceOrder(
      [{ priceSnapshot: 50_00, qty: 2, suppliedQty: 1 }],
      { ...base, subtotal: 100_00 },
    );
    expect(out.subtotal).toBe(50_00);
    expect(out.total).toBe(50_00 + 5_00 - 5_00); // discount halves with the subtotal
  });

  // A shrinking order must never buy a bigger discount than the one that was offered.
  it('scales the discount down and never up', () => {
    const out = repriceOrder([{ priceSnapshot: 50_00, qty: 2, suppliedQty: 1 }], base);
    expect(out.discount).toBe(5_00);
    expect(out.discount).toBeLessThanOrEqual(base.discount);
  });

  it('leaves the delivery fee alone — the rider rides the same distance', () => {
    const out = repriceOrder([{ priceSnapshot: 10_00, qty: 10, suppliedQty: 1 }], base);
    expect(out.total - out.subtotal + out.discount).toBe(5_00);
  });

  it('reduces what the rider collects', () => {
    const out = repriceOrder([{ priceSnapshot: 50_00, qty: 2, suppliedQty: 1 }], base);
    expect(out.dueOnDelivery).toBe(out.total);
    expect(out.reduction).toBe(50_00 - 5_00);
  });

  // The case that must never be swallowed: they already paid more than it is now worth.
  it('surfaces an overpayment on a prepaid order rather than netting it off', () => {
    const out = repriceOrder(
      [{ priceSnapshot: 50_00, qty: 2, suppliedQty: 1 }],
      { subtotal: 100_00, discount: 0, deliveryFee: 5_00, advanceAmount: 105_00 },
    );
    expect(out.total).toBe(55_00);
    expect(out.dueOnDelivery).toBe(0);
    expect(out.overpaid).toBe(50_00);
  });

  it('knows an increase when it sees one', () => {
    expect(isReductionOnly([{ priceSnapshot: 1, qty: 2, suppliedQty: 3 }])).toBe(false);
    expect(isReductionOnly([{ priceSnapshot: 1, qty: 2, suppliedQty: 0 }])).toBe(true);
  });
});

describe('a shop running out, end to end', () => {
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

  const groceryOrder = async (code: string, status: 'CONFIRMED' | 'PREPARING' | 'ON_THE_WAY' = 'CONFIRMED') => {
    const order = await prisma.unsafeRaw.order.create({
      data: {
        tenantId: shop, code,
        channel: 'OWN_STORE', customerPhone: '01744443333',
        status, fulfillment: 'DELIVERY',
        subtotal: 100_00, deliveryFee: 5_00, discount: 0, total: 105_00, dueOnDelivery: 105_00,
        deliveryAddress: { area: 'Bazar', landmark: 'Beside the Eidgah field' } as any,
        items: {
          create: [
            { nameSnapshot: 'Rice 5kg', priceSnapshot: 60_00, qty: 1 },
            { nameSnapshot: 'Lentils 1kg', priceSnapshot: 20_00, qty: 2 },
          ],
        },
      },
      include: { items: true },
    });
    return order;
  };

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();
    const tenant = await prisma.unsafeRaw.tenant.create({ data: { slug: 'grocer', name: 'Mudi Dokan' } });
    shop = tenant.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('removes a line, reprices, and says what went', async () => {
    const order = await groceryOrder('FHOS001');
    const rice = order.items.find((i) => i.nameSnapshot === 'Rice 5kg')!;

    const result: any = await ops.repriceForStock(shop, order.id, [{ itemId: rice.id, qty: 0 }], 'vendor:test');
    expect(result.dropped).toEqual(['Rice 5kg']);

    const after = await prisma.unsafeRaw.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    expect(after!.subtotal).toBe(40_00);
    expect(after!.total).toBe(45_00);
    expect(after!.dueOnDelivery).toBe(45_00);
    expect(after!.items).toHaveLength(1);
  });

  it('writes what happened onto the order, with who did it', async () => {
    const order = await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHOS001' } });
    const events = await prisma.unsafeRaw.orderEvent.findMany({ where: { orderId: order!.id } });
    const note = events.find((e) => e.note?.startsWith('Out of stock'));
    expect(note?.note).toContain('removed Rice 5kg');
    expect(note?.actor).toBe('vendor:test');
  });

  it('reduces a quantity without removing the line', async () => {
    const order = await groceryOrder('FHOS002');
    const lentils = order.items.find((i) => i.nameSnapshot === 'Lentils 1kg')!;

    await ops.repriceForStock(shop, order.id, [{ itemId: lentils.id, qty: 1 }], 'vendor:test');

    const after = await prisma.unsafeRaw.order.findUnique({
      where: { id: order.id },
      include: { items: true },
    });
    expect(after!.items).toHaveLength(2);
    expect(after!.subtotal).toBe(80_00);
  });

  // The bag is packed and the rider is carrying it. Changing the total now would have them
  // collecting an amount that does not match what is in their hands.
  it('refuses once the rider has collected it', async () => {
    const order = await groceryOrder('FHOS003', 'ON_THE_WAY');
    const rice = order.items[0];
    await expect(
      ops.repriceForStock(shop, order.id, [{ itemId: rice.id, qty: 0 }], 'vendor:test'),
    ).rejects.toThrow(/before the rider collects/i);
  });

  it('refuses to add anything the customer did not agree to', async () => {
    const order = await groceryOrder('FHOS004');
    const rice = order.items[0];
    await expect(
      ops.repriceForStock(shop, order.id, [{ itemId: rice.id, qty: 5 }], 'vendor:test'),
    ).rejects.toThrow(/less than was ordered/i);
  });

  it('refuses to empty an order instead of cancelling it', async () => {
    const order = await groceryOrder('FHOS005');
    await expect(
      ops.repriceForStock(shop, order.id, order.items.map((i) => ({ itemId: i.id, qty: 0 })), 'vendor:test'),
    ).rejects.toThrow(/cancel the order/i);
  });

  it('does nothing, loudly, when nothing actually changed', async () => {
    const order = await groceryOrder('FHOS006');
    const result: any = await ops.repriceForStock(
      shop, order.id, order.items.map((i) => ({ itemId: i.id, qty: i.qty })), 'vendor:test',
    );
    expect(result.unchanged).toBe(true);

    const after = await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } });
    expect(after!.total).toBe(105_00);
  });

  it('cannot be done to another shop’s order', async () => {
    const other = await prisma.unsafeRaw.tenant.create({ data: { slug: 'other-grocer', name: 'Other' } });
    const order = await groceryOrder('FHOS007');
    await expect(
      ops.repriceForStock(other.id, order.id, [{ itemId: order.items[0].id, qty: 0 }], 'vendor:test'),
    ).rejects.toThrow();

    const untouched = await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } });
    expect(untouched!.total).toBe(105_00);
  });

  it('keeps the landmark the rider actually navigates by', async () => {
    const order = await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHOS001' } });
    expect((order!.deliveryAddress as any).landmark).toBe('Beside the Eidgah field');
  });
});
