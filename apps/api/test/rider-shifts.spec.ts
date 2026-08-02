import { ConfigService } from '@nestjs/config';
import { canCarry, cartWeightGrams, formatWeight } from '@foodhub/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { RiderLedgerService } from '../src/rider-ledger/rider-ledger.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { OrdersService } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Attendance, performance and the button for when something has gone wrong.
 *
 * The performance numbers are the part worth defending. Every one is counted from
 * something that actually happened and named for what it actually measures — there is no
 * "acceptance rate" here, because nothing records an offer being *seen*, and a statistic
 * about an unobserved event is a number somebody could be judged on and could not check.
 */
describe('shifts, performance and alerts', () => {
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
  const TOKEN = 'shift-rider-token';

  const orderFor = (code: string) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId: shop, code,
        channel: 'OWN_STORE', customerPhone: '01799990000',
        status: 'READY', fulfillment: 'DELIVERY',
        subtotal: 20_000, deliveryFee: 5_000, total: 25_000, dueOnDelivery: 25_000,
        deliveryAddress: { area: 'Bazar' } as any,
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const tenant = await prisma.unsafeRaw.tenant.create({ data: { slug: 'shift-shop', name: 'Shift Shop' } });
    shop = tenant.id;

    const rider = await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Karim', phone: '01700000601', token: TOKEN,
        shops: { create: { tenantId: shop, approved: true, approvedAt: new Date() } },
        areas: { create: [{ label: 'Bazar', shape: { areas: ['Bazar'] } as any }] },
      },
    });
    riderId = rider.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  describe('attendance comes from the duty switch', () => {
    it('opens a shift when they go on duty', async () => {
      await ops.setDuty(TOKEN, true);
      const shifts = await prisma.unsafeRaw.riderShift.findMany({ where: { riderId } });
      expect(shifts).toHaveLength(1);
      expect(shifts[0].endedAt).toBeNull();
    });

    // Otherwise a refreshed page or a double tap becomes a second day's attendance.
    it('does not open a second shift if they are already on', async () => {
      await ops.setDuty(TOKEN, true);
      expect(await prisma.unsafeRaw.riderShift.count({ where: { riderId } })).toBe(1);
    });

    it('closes it when they go off', async () => {
      await ops.setDuty(TOKEN, false);
      const shifts = await prisma.unsafeRaw.riderShift.findMany({ where: { riderId } });
      expect(shifts[0].endedAt).not.toBeNull();
    });

    it('opens a fresh one next time', async () => {
      await ops.setDuty(TOKEN, true);
      expect(await prisma.unsafeRaw.riderShift.count({ where: { riderId } })).toBe(2);
    });
  });

  describe('performance', () => {
    it('reports nothing rather than zero when there is nothing to report', async () => {
      const p = await ops.riderPerformance(riderId);
      expect(p.carried).toBe(0);
      // Not 0% — they have not refused anything, and 0 would read as a bad rider.
      expect(p.takeRate).toBeNull();
      expect(p.avgPickupToDoorMinutes).toBeNull();
    });

    it('counts what was delivered, returned, passed and failed', async () => {
      const delivered = await orderFor('FHSH001');
      await ops.acceptWork(TOKEN, delivered.id);
      await ops.planTrip(TOKEN);
      let sheet = await ops.tripSheet(TOKEN);
      sheet = await ops.completeStop(TOKEN, sheet.stops.find((s) => s.active)!.id); // pickup
      await ops.completeStop(TOKEN, sheet.stops.find((s) => s.active)!.id); // drop

      const passed = await orderFor('FHSH002');
      await ops.skipWork(TOKEN, passed.id);

      const p = await ops.riderPerformance(riderId);
      expect(p.delivered).toBe(1);
      expect(p.carried).toBe(1);
      expect(p.passed).toBe(1);
      // Taken vs passed — the honest name for what this is.
      expect(p.takeRate).toBe(50);
      expect(p.avgPickupToDoorMinutes).not.toBeNull();
    });

    it('separates a failed attempt from a return', async () => {
      const order = await orderFor('FHSH003');
      await ops.acceptWork(TOKEN, order.id);
      await ops.planTrip(TOKEN);
      let sheet = await ops.tripSheet(TOKEN);
      sheet = await ops.completeStop(TOKEN, sheet.stops.find((s) => s.active)!.id);

      const drop = sheet.stops.find((s) => s.active && s.kind === 'DROP')!;
      await ops.failStop(TOKEN, drop.id, 'NO_ANSWER');
      let p = await ops.riderPerformance(riderId);
      expect(p.failedAttempts).toBe(1);
      expect(p.returned).toBe(0); // tried, not given up on

      await ops.returnStop(TOKEN, drop.id);
      p = await ops.riderPerformance(riderId);
      expect(p.returned).toBe(1);
      expect(p.failedAttempts).toBe(1);
    });

    it('counts hours on duty from the shifts', async () => {
      const p = await ops.riderPerformance(riderId);
      expect(p.shifts).toBeGreaterThanOrEqual(2);
      expect(p.onDutyHours).toBeGreaterThanOrEqual(0);
    });
  });

  describe('profile', () => {
    it('starts as a motorcycle, because that is what most of them are', async () => {
      const profile = await ops.riderProfile(TOKEN);
      expect(profile).toMatchObject({ vehicle: 'MOTORCYCLE', capacityKg: 15 });
    });

    it('is the rider’s own to change — only they know what fits', async () => {
      const updated = await ops.setRiderProfile(TOKEN, {
        vehicle: 'VAN',
        capacityKg: 120,
        emergencyPhone: '01911111111',
      });
      expect(updated).toMatchObject({ vehicle: 'VAN', capacityKg: 120, emergencyPhone: '01911111111' });
    });
  });

  describe('when something goes wrong', () => {
    it('reaches every shop the rider is out for', async () => {
      await ops.raiseAlert(TOKEN, 'BREAKDOWN', 'Chain snapped near the bridge');

      const alerts = await ops.shopAlerts(shop);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].kind).toBe('BREAKDOWN');
      // The shop needs both numbers: the rider's, and whoever the rider said to ring.
      expect(alerts[0].rider.phone).toBe('01700000601');
      expect(alerts[0].rider.emergencyPhone).toBe('01911111111');
    });

    it('drops off the list once somebody has dealt with it', async () => {
      const [alert] = await ops.shopAlerts(shop);
      await ops.resolveAlert(shop, alert.id);
      expect(await ops.shopAlerts(shop)).toHaveLength(0);
    });

    it('cannot be resolved by a shop the rider does not work for', async () => {
      const other = await prisma.unsafeRaw.tenant.create({ data: { slug: 'nosy', name: 'Nosy Shop' } });
      await ops.raiseAlert(TOKEN, 'UNSAFE');
      const [alert] = await ops.shopAlerts(shop);

      await expect(ops.resolveAlert(other.id, alert.id)).rejects.toThrow();
      expect(await ops.shopAlerts(other.id)).toHaveLength(0);
    });
  });
});

/**
 * What will physically go on the vehicle.
 *
 * The rule that matters is the one about not knowing: a shop that has never weighed a
 * product must not find its whole catalogue undeliverable the day this ships, so an
 * unweighed order is allowed through rather than assumed heavy. A partly-weighed one is
 * judged on what is known — half a sack of rice is still a sack of rice.
 */
describe('carrying capacity', () => {
  const w = (grams: number, qty = 1) => ({ weightGrams: grams, qty });

  it('adds up what it can and counts what it cannot', () => {
    expect(cartWeightGrams([w(500, 2), w(0), w(1_000)])).toEqual({ grams: 2_000, unknownLines: 1 });
  });

  it('lets an order nobody has weighed through', () => {
    expect(canCarry(cartWeightGrams([w(0), w(0)]), 15)).toBe(true);
  });

  it('refuses a sack of rice on a motorcycle', () => {
    expect(canCarry(cartWeightGrams([w(25_000)]), 15)).toBe(false);
    expect(canCarry(cartWeightGrams([w(25_000)]), 150)).toBe(true); // the van can
  });

  it('judges a partly-weighed order on the part it knows', () => {
    // 20kg known plus something unweighed is already too much; the unknown cannot rescue it.
    expect(canCarry(cartWeightGrams([w(20_000), w(0)]), 15)).toBe(false);
  });

  it('treats no capacity as no limit rather than as zero', () => {
    expect(canCarry(cartWeightGrams([w(99_000)]), 0)).toBe(true);
  });

  it('formats for a screen, and says nothing when it knows nothing', () => {
    expect(formatWeight(0)).toBeNull();
    expect(formatWeight(750)).toBe('750 g');
    expect(formatWeight(2_000)).toBe('2 kg');
    expect(formatWeight(2_500)).toBe('2.5 kg');
  });
});

/**
 * The operation seen whole.
 *
 * Each shop's panel shows its own corner. This is the view that notices two villages have
 * five riders between them and a third has none — and, more usefully, that an order has
 * been sitting unclaimed because its address matches nobody's patch.
 */
describe('the hub view', () => {
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

  let shopA: string;
  let shopB: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const [a, b] = await Promise.all([
      prisma.unsafeRaw.tenant.create({ data: { slug: 'hub-a', name: 'Hotel A' } }),
      prisma.unsafeRaw.tenant.create({ data: { slug: 'hub-b', name: 'Grocer B' } }),
    ]);
    shopA = a.id;
    shopB = b.id;

    await prisma.unsafeRaw.rider.create({
      data: {
        name: 'On', phone: '01700000701', token: 'hub-on', onDuty: true, dutySince: new Date(),
        lat: 23.75, lng: 90.38, locationAt: new Date(),
        shops: { create: [
          { tenantId: shopA, approved: true, approvedAt: new Date() },
          { tenantId: shopB, approved: true, approvedAt: new Date() },
        ] },
        areas: { create: [{ label: 'Bazar', shape: { areas: ['Bazar'] } as any }] },
      },
    });
    await prisma.unsafeRaw.rider.create({
      data: { name: 'Off', phone: '01700000702', token: 'hub-off' },
    });
  });

  afterAll(() => prisma.onModuleDestroy());

  it('lists every rider across every shop, on duty first', async () => {
    const hub = await ops.hubRiders();
    expect(hub.map((r) => r.name)).toEqual(['On', 'Off']);
    expect(hub[0].shops.sort()).toEqual(['Grocer B', 'Hotel A']);
    expect(hub[0].areas).toEqual(['Bazar']);
  });

  // A pin with no age beside it is a pin somebody will believe long after it stopped
  // being true, so position and freshness always travel together.
  it('carries the age of a position alongside it', async () => {
    const hub = await ops.hubRiders();
    expect(hub[0].lat).toBeCloseTo(23.75, 3);
    expect(hub[0].locationAt).not.toBeNull();
    expect(hub[1].lat).toBeNull();
    expect(hub[1].locationAt).toBeNull();
  });

  it('counts nothing waiting when nothing is', async () => {
    const out = await ops.hubUnclaimed();
    expect(out).toMatchObject({ waiting: 0, unmatchable: 0 });
  });

  it('separates work nobody took from work nobody CAN take', async () => {
    await prisma.unsafeRaw.order.create({
      data: {
        tenantId: shopA, code: 'FHHU001', channel: 'OWN_STORE', customerPhone: '01700000000',
        status: 'CONFIRMED', fulfillment: 'DELIVERY',
        subtotal: 100, deliveryFee: 0, total: 100,
        deliveryAddress: { area: 'Bazar' } as any,
      },
    });
    await prisma.unsafeRaw.order.create({
      data: {
        tenantId: shopB, code: 'FHHU002', channel: 'OWN_STORE', customerPhone: '01700000000',
        status: 'READY', fulfillment: 'DELIVERY',
        subtotal: 100, deliveryFee: 0, total: 100,
        // No area and no pin: this one is a data problem a shop can fix today, and it must
        // not be lumped in with "we are short of riders".
        deliveryAddress: { addressLine: 'near the big tree' } as any,
      },
    });

    const out = await ops.hubUnclaimed();
    expect(out.waiting).toBe(2);
    expect(out.unmatchable).toBe(1);
    expect(out.orders.find((o) => o.code === 'FHHU002')!.matchable).toBe(false);
    expect(out.orders.map((o) => o.store).sort()).toEqual(['Grocer B', 'Hotel A']);
  });

  it('stops counting an order once somebody has it', async () => {
    const order = await prisma.unsafeRaw.order.findFirst({ where: { code: 'FHHU001' } });
    await ops.acceptWork('hub-on', order!.id);

    const out = await ops.hubUnclaimed();
    expect(out.orders.map((o) => o.code)).not.toContain('FHHU001');
    expect(out.waiting).toBe(1);
  });
});
