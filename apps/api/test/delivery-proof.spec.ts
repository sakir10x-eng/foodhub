import { ConfigService } from '@nestjs/config';
import {
  DELIVERY_OTP_LENGTH,
  DELIVERY_OTP_MAX_ATTEMPTS,
  ORDER_STATUS_LABEL,
  canTransition,
  deliveryOtpMatches,
  isTerminal,
  makeDeliveryOtp,
  progressIndex,
  type OrderStatus,
} from '@foodhub/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { RiderLedgerService } from '../src/rider-ledger/rider-ledger.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { OrdersService } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Proof at the door, and a name for the deliveries that do not happen.
 *
 * The code is four digits said out loud — no photo to upload on a village signal, no
 * signature on a cracked screen. What makes it worth anything is not its length but the
 * attempt counter and the fact that the **rider never sees it**; both are tested here.
 */

describe('the code itself', () => {
  it('is always the full length, zero-padded', () => {
    expect(makeDeliveryOtp(() => 0)).toBe('0000');
    expect(makeDeliveryOtp(() => 0.0042)).toHaveLength(DELIVERY_OTP_LENGTH);
    expect(makeDeliveryOtp(() => 0.99999)).toHaveLength(DELIVERY_OTP_LENGTH);
  });

  it('forgives spaces and nothing else', () => {
    expect(deliveryOtpMatches('1234', '1234')).toBe(true);
    expect(deliveryOtpMatches('1234', ' 12 34 ')).toBe(true);
    expect(deliveryOtpMatches('1234', '1235')).toBe(false);
    expect(deliveryOtpMatches('0042', '42')).toBe(false);
    expect(deliveryOtpMatches(null, '1234')).toBe(false);
  });
});

/**
 * A new OrderStatus has to be wired into every list that enumerates them, and every one it
 * is missing from fails silently — a blank badge, a status nobody can set, a stuck order.
 */
describe('RETURNED is wired in everywhere', () => {
  it('is reachable from the road and leads only to a refund', () => {
    expect(canTransition('ON_THE_WAY', 'RETURNED')).toBe(true);
    expect(canTransition('RETURNED', 'REFUNDED')).toBe(true);
    // Not from anywhere else: a parcel can only come back if it went out.
    expect(canTransition('READY', 'RETURNED')).toBe(false);
    expect(canTransition('PREPARING', 'RETURNED')).toBe(false);
    expect(canTransition('RETURNED', 'DELIVERED')).toBe(false);
  });

  it('is finished, and is not a step on the happy path', () => {
    expect(isTerminal('RETURNED')).toBe(true);
    expect(progressIndex('RETURNED' as OrderStatus)).toBe(-1);
  });

  it('has a label, so no screen renders a blank badge', () => {
    expect(ORDER_STATUS_LABEL.RETURNED).toBe('Returned to shop');
  });
});

describe('at the door', () => {
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
  const TOKEN = 'proof-rider-token';

  const newOrder = (code: string) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId: shop, code,
        channel: 'OWN_STORE',
        customerPhone: '01766666666',
        status: 'READY',
        fulfillment: 'DELIVERY',
        subtotal: 20_000, deliveryFee: 5_000, total: 25_000, dueOnDelivery: 25_000,
        deliveryAddress: { area: 'Bazar' } as any,
      },
    });

  /** Take an order all the way to the door and return its drop stop. */
  const rideTo = async (code: string) => {
    const order = await newOrder(code);
    await ops.acceptWork(TOKEN, order.id);
    await ops.planTrip(TOKEN);

    let sheet = await ops.tripSheet(TOKEN);
    while (sheet.stops.some((s) => s.kind === 'PICKUP' && !s.done)) {
      const pickup = sheet.stops.find((s) => s.active)!;
      sheet = await ops.completeStop(TOKEN, pickup.id);
    }
    return { order, drop: sheet.stops.find((s) => s.kind === 'DROP' && s.code === code && !s.done)! };
  };

  const otpOf = (id: string) =>
    TenantContext.runAsTenant(shop, () =>
      prisma.db.order.findUnique({ where: { id }, select: { deliveryOtp: true } }).then((o) => o!.deliveryOtp!),
    );

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'proof-shop', name: 'Proof Shop', phone: '01900000000', deliveryOtpRequired: true },
    });
    shop = tenant.id;

    await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Karim', phone: '01700000301', token: TOKEN,
        onDuty: true, dutySince: new Date(),
        shops: { create: { tenantId: shop, approved: true, approvedAt: new Date() } },
        areas: { create: [{ label: 'Bazar', shape: { areas: ['Bazar'] } as any }] },
      },
    });
  });

  afterAll(() => prisma.onModuleDestroy());

  it('mints a code when the parcel goes onto the road, not before', async () => {
    const order = await newOrder('FHDP001');
    expect((await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } }))!.deliveryOtp).toBeNull();

    await ops.acceptWork(TOKEN, order.id);
    await ops.planTrip(TOKEN);
    const sheet = await ops.tripSheet(TOKEN);
    await ops.completeStop(TOKEN, sheet.stops.find((s) => s.active)!.id);

    const code = (await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } }))!.deliveryOtp;
    expect(code).toHaveLength(DELIVERY_OTP_LENGTH);
  });

  // The whole mechanism rests on this. A code the rider can read proves nothing at all.
  it('never puts the code on the rider’s own screens', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    const code = await otpOf((await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHDP001' } }))!.id);

    expect(JSON.stringify(sheet)).not.toContain(code);
    expect(JSON.stringify(await ops.riderQueue(TOKEN))).not.toContain(code);
    expect(JSON.stringify(await ops.availableWork(TOKEN))).not.toContain(code);
  });

  it('refuses a handover with no code at all', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    const drop = sheet.stops.find((s) => s.active && s.kind === 'DROP')!;
    await expect(ops.completeStop(TOKEN, drop.id)).rejects.toThrow(/delivery code/i);
  });

  it('counts wrong codes and says how many are left', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    const drop = sheet.stops.find((s) => s.active && s.kind === 'DROP')!;

    await expect(ops.completeStop(TOKEN, drop.id, '0000')).rejects.toThrow(/2 more tries/i);
    await expect(ops.completeStop(TOKEN, drop.id, '0001')).rejects.toThrow(/1 more try/i);
  });

  it('sends the rider to the shop once the tries are gone, and names the number', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    const drop = sheet.stops.find((s) => s.active && s.kind === 'DROP')!;

    await expect(ops.completeStop(TOKEN, drop.id, '0002')).rejects.toThrow(/too many/i);
    // And the right code no longer helps — otherwise the limit is decoration.
    const real = await otpOf((await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHDP001' } }))!.id);
    await expect(ops.completeStop(TOKEN, drop.id, real)).rejects.toThrow(/01900000000/);
  });

  it('lets the shop release it, and leaves that on the record', async () => {
    const order = (await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHDP001' } }))!;
    await ops.releaseDeliveryProof(shop, order.id, 'vendor:test-user');

    const events = await prisma.unsafeRaw.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events.some((e) => e.note?.includes('waived') && e.actor === 'vendor:test-user')).toBe(true);

    const sheet = await ops.tripSheet(TOKEN);
    const drop = sheet.stops.find((s) => s.active && s.kind === 'DROP')!;
    await ops.completeStop(TOKEN, drop.id);

    const after = await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe('DELIVERED');
  });

  it('accepts the right code, spaces and all', async () => {
    const { order, drop } = await rideTo('FHDP002');
    const code = await otpOf(order.id);

    await ops.completeStop(TOKEN, drop.id, ` ${code.slice(0, 2)} ${code.slice(2)} `);
    const after = await prisma.unsafeRaw.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe('DELIVERED');
    expect(after!.deliveryOtpAttempts).toBeLessThan(DELIVERY_OTP_MAX_ATTEMPTS);
  });
});

describe('when nobody answers', () => {
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
  const TOKEN = 'fail-rider-token';

  const newOrder = (code: string) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId: shop, code,
        channel: 'OWN_STORE',
        customerPhone: '01777777777',
        status: 'READY',
        fulfillment: 'DELIVERY',
        subtotal: 20_000, deliveryFee: 5_000, total: 25_000, dueOnDelivery: 25_000,
        deliveryAddress: { area: 'Bazar' } as any,
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'fail-shop', name: 'Fail Shop' },
    });
    shop = tenant.id;

    const rider = await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Jashim', phone: '01700000401', token: TOKEN,
        onDuty: true, dutySince: new Date(),
        lat: 23.75, lng: 90.38,
        shops: { create: { tenantId: shop, approved: true, approvedAt: new Date() } },
        areas: { create: [{ label: 'Bazar', shape: { areas: ['Bazar'] } as any }] },
      },
    });
    riderId = rider.id;

    for (const code of ['FHFA001', 'FHFA002']) {
      const o = await newOrder(code);
      await ops.acceptWork(TOKEN, o.id);
    }
    await ops.planTrip(TOKEN);
    let sheet = await ops.tripSheet(TOKEN);
    while (sheet.stops.some((s) => s.kind === 'PICKUP' && !s.done)) {
      sheet = await ops.completeStop(TOKEN, sheet.stops.find((s) => s.active)!.id);
    }
  });

  afterAll(() => prisma.onModuleDestroy());

  it('records the reason and the place it was claimed from', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    const drop = sheet.stops.find((s) => s.active && s.kind === 'DROP')!;
    await ops.failStop(TOKEN, drop.id, 'NO_ANSWER', 'Gate locked, phone off');

    const attempt = await prisma.unsafeRaw.deliveryAttempt.findFirst({ where: { riderId } });
    expect(attempt!.reason).toBe('NO_ANSWER');
    expect(attempt!.note).toBe('Gate locked, phone off');
    // An attempt filed from the shop's own courtyard should be recognisable later.
    expect(attempt!.lat).toBeCloseTo(23.75, 4);
  });

  // "Nobody home" in a village means "come back after the others", not "give up".
  it('moves it to the end of the run instead of closing it', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    const drops = sheet.stops.filter((s) => s.kind === 'DROP');
    const failed = drops.find((s) => s.code === 'FHFA001')!;

    expect(failed.done).toBe(false);
    expect(failed.seq).toBeGreaterThan(drops.find((s) => s.code === 'FHFA002')!.seq);
    expect(sheet.stops.find((s) => s.active)!.code).toBe('FHFA002');

    const row = await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHFA001' } });
    expect(row!.status).toBe('ON_THE_WAY');
  });

  it('takes it back to the shop as RETURNED, not CANCELLED', async () => {
    let sheet = await ops.tripSheet(TOKEN);
    sheet = await ops.completeStop(TOKEN, sheet.stops.find((s) => s.active)!.id); // deliver FHFA002

    const back = sheet.stops.find((s) => s.code === 'FHFA001' && s.kind === 'DROP')!;
    await ops.returnStop(TOKEN, back.id);

    const row = await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHFA001' } });
    // The food was cooked and the journey was ridden. Calling that "cancelled" would hide
    // the cost and the reason both.
    expect(row!.status).toBe('RETURNED');
  });

  it('closes the run once nothing is left', async () => {
    const { trip } = await ops.tripSheet(TOKEN);
    expect(trip).toBeNull();
  });

  it('refuses to fail or return a pickup', async () => {
    const o = await newOrder('FHFA010');
    await ops.acceptWork(TOKEN, o.id);
    const { stops } = await ops.tripSheet(TOKEN);
    const pickup = stops.find((s) => s.kind === 'PICKUP')!;

    await expect(ops.failStop(TOKEN, pickup.id, 'NO_ANSWER')).rejects.toThrow(/only a delivery/i);
    await expect(ops.returnStop(TOKEN, pickup.id)).rejects.toThrow(/only a delivery/i);
  });
});
