import { ConfigService } from '@nestjs/config';
import { planStops, riderCoordsVisible, type PlannedStop } from '@foodhub/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { RiderLedgerService } from '../src/rider-ledger/rider-ledger.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { OrdersService, toDto } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * One rider, two shops, three houses.
 *
 * The reason batching needs its own tests is not the routing — it is that **batching
 * reopens a privacy hole that was already closed once**. `riderVisibleFor` excludes READY
 * because a rider marked ready is usually standing at somebody else's door. Carry three
 * parcels at once and ON_THE_WAY has exactly that property: the rider is at the first
 * customer's gate while the second and third watch the dot. So the position is narrowed to
 * the customer the rider is actually riding towards, and the rest is proved below.
 */

describe('planning a run', () => {
  const stop = (over: Partial<PlannedStop>): PlannedStop => ({
    orderId: 'o', kind: 'DROP', placedAt: 0, ...over,
  });

  it('collects everything before delivering anything', () => {
    const planned = planStops([
      stop({ orderId: 'a', kind: 'DROP', placedAt: 1 }),
      stop({ orderId: 'b', kind: 'PICKUP', tenantId: 's1', placedAt: 2 }),
      stop({ orderId: 'a', kind: 'PICKUP', tenantId: 's1', placedAt: 1 }),
      stop({ orderId: 'b', kind: 'DROP', placedAt: 2 }),
    ]);
    expect(planned.map((s) => s.kind)).toEqual(['PICKUP', 'PICKUP', 'DROP', 'DROP']);
  });

  it('keeps one shop’s parcels together so the rider visits a counter once', () => {
    const planned = planStops([
      stop({ orderId: 'a', kind: 'PICKUP', tenantId: 'shopA', placedAt: 1 }),
      stop({ orderId: 'b', kind: 'PICKUP', tenantId: 'shopB', placedAt: 2 }),
      stop({ orderId: 'c', kind: 'PICKUP', tenantId: 'shopA', placedAt: 3 }),
    ]);
    expect(planned.map((s) => s.tenantId)).toEqual(['shopA', 'shopA', 'shopB']);
  });

  it('visits the nearer drop first when it knows where they are', () => {
    const planned = planStops(
      [
        stop({ orderId: 'far', point: { lat: 23.9, lng: 90.9 }, placedAt: 1 }),
        stop({ orderId: 'near', point: { lat: 23.51, lng: 90.51 }, placedAt: 2 }),
      ],
      { lat: 23.5, lng: 90.5 },
    );
    expect(planned.map((s) => s.orderId)).toEqual(['near', 'far']);
  });

  // Half of a village's orders have no pin. They must not be shuffled into a geometric
  // order they cannot support — they keep their arrival order and go last.
  it('leaves stops with no coordinates in arrival order, at the end', () => {
    const planned = planStops(
      [
        stop({ orderId: 'blind-2', placedAt: 2 }),
        stop({ orderId: 'located', point: { lat: 23.51, lng: 90.51 }, placedAt: 3 }),
        stop({ orderId: 'blind-1', placedAt: 1 }),
      ],
      { lat: 23.5, lng: 90.5 },
    );
    expect(planned.map((s) => s.orderId)).toEqual(['located', 'blind-1', 'blind-2']);
  });
});

describe('who may see the rider on a batched run', () => {
  it('shows nothing before the food is on its way, exactly as before', () => {
    expect(riderCoordsVisible('READY', { stopsAhead: 0, isActiveStop: true })).toBe(false);
  });

  it('shows the rider to the customer they are riding towards', () => {
    expect(riderCoordsVisible('ON_THE_WAY', { stopsAhead: 0, isActiveStop: true })).toBe(true);
  });

  // The whole reason this function exists.
  it('hides the rider from customers further down the run', () => {
    expect(riderCoordsVisible('ON_THE_WAY', { stopsAhead: 2, isActiveStop: false })).toBe(false);
  });

  it('leaves an order that is not on a run behaving as it always did', () => {
    expect(riderCoordsVisible('ON_THE_WAY', null)).toBe(true);
  });
});

describe('a run across two shops, end to end', () => {
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

  let kitchen: string;
  let grocer: string;
  let riderId: string;
  const TOKEN = 'trip-rider-token';
  const PHONE = '01755555555';

  const order = (tenantId: string, code: string, area: string) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId, code,
        channel: 'OWN_STORE',
        customerPhone: PHONE,
        status: 'READY',
        fulfillment: 'DELIVERY',
        subtotal: 30_000, deliveryFee: 5_000, total: 35_000, dueOnDelivery: 35_000,
        deliveryAddress: { area, phone: PHONE } as any,
      },
    });

  const track = (code: string, tenantId: string) =>
    TenantContext.runAsTenant(tenantId, async () => {
      const row = await prisma.db.order.findUnique({
        where: { code },
        include: {
          items: true,
          rider: { select: { name: true, phone: true, lat: true, lng: true, locationAt: true } },
          tripStops: {
            where: { kind: 'DROP' as const },
            select: { seq: true, completedAt: true, trip: { select: { status: true, activeSeq: true } } },
          },
        },
      });
      return toDto(row);
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const [k, g] = await Promise.all([
      prisma.unsafeRaw.tenant.create({ data: { slug: 'bhater-hotel', name: 'Bhater Hotel' } }),
      prisma.unsafeRaw.tenant.create({ data: { slug: 'mudi-dokan', name: 'Mudi Dokan' } }),
    ]);
    kitchen = k.id;
    grocer = g.id;

    const rider = await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Karim', phone: '01700000201', token: TOKEN,
        onDuty: true, dutySince: new Date(),
        shops: {
          create: [
            { tenantId: kitchen, approved: true, approvedAt: new Date() },
            { tenantId: grocer, approved: true, approvedAt: new Date() },
          ],
        },
        areas: { create: [{ label: 'Bazar', shape: { areas: ['Bazar'] } as any }] },
      },
    });
    riderId = rider.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('builds one run out of two shops’ work', async () => {
    const cooked = await order(kitchen, 'FHTR001', 'Bazar');
    const rice = await order(grocer, 'FHTR002', 'Bazar');

    await ops.acceptWork(TOKEN, cooked.id);
    await ops.acceptWork(TOKEN, rice.id);

    const { trip, stops } = await ops.tripSheet(TOKEN);
    expect(trip).not.toBeNull();
    // Two orders, four stops: a counter and a door each.
    expect(stops).toHaveLength(4);
    expect(stops.filter((s) => s.kind === 'PICKUP').map((s) => s.store).sort())
      .toEqual(['Bhater Hotel', 'Mudi Dokan']);
  });

  it('puts both counters before either door once planned', async () => {
    const { stops } = await ops.planTrip(TOKEN);
    expect(stops.map((s) => s.kind)).toEqual(['PICKUP', 'PICKUP', 'DROP', 'DROP']);
    expect(stops[0].active).toBe(true);
  });

  it('refuses a stop taken out of order', async () => {
    const { stops } = await ops.tripSheet(TOKEN);
    const lastDrop = stops[3];
    await expect(ops.completeStop(TOKEN, lastDrop.id)).rejects.toThrow(/before this one/i);
  });

  it('marks the parcel collected and moves the order onto the road', async () => {
    const { stops } = await ops.tripSheet(TOKEN);
    const after = await ops.completeStop(TOKEN, stops[0].id);

    expect(after.stops[0].done).toBe(true);
    expect(after.stops[1].active).toBe(true);

    const code = stops[0].code;
    const tenantId = code === 'FHTR001' ? kitchen : grocer;
    const dto = await track(code, tenantId);
    expect(dto.status).toBe('ON_THE_WAY');

    // Recorded as a timestamp and an event, not as a new status on the state machine.
    const row = await prisma.unsafeRaw.order.findUnique({ where: { code } });
    expect(row!.pickedUpAt).not.toBeNull();
  });

  // The batching leak, closed.
  it('shows the rider only to the customer whose door is next', async () => {
    const sheet = await ops.tripSheet(TOKEN);
    await ops.completeStop(TOKEN, sheet.stops[1].id); // collect the second parcel too

    await ops.reportRiderLocation({ token: TOKEN, lat: 23.75, lng: 90.38, accuracy: 10 });

    const current = await ops.tripSheet(TOKEN);
    const drops = current.stops.filter((s) => s.kind === 'DROP');
    const nextDrop = drops.find((s) => s.active)!;
    const laterDrop = drops.find((s) => !s.active)!;

    const nextTenant = nextDrop.code === 'FHTR001' ? kitchen : grocer;
    const laterTenant = laterDrop.code === 'FHTR001' ? kitchen : grocer;

    const beingVisited = await track(nextDrop.code, nextTenant);
    const stillWaiting = await track(laterDrop.code, laterTenant);

    // The customer being ridden to gets the map.
    expect(beingVisited.rider?.lat).toBeCloseTo(23.75, 4);
    expect(beingVisited.rider?.stopsAhead).toBe(0);

    // The one after gets a queue position and NO coordinates — the rider is standing at
    // somebody else's gate, and drawing that is what this whole change prevents.
    expect(stillWaiting.rider?.name).toBe('Karim');
    expect(stillWaiting.rider?.phone).toBe('01700000201');
    expect(stillWaiting.rider?.lat).toBeNull();
    expect(stillWaiting.rider?.lng).toBeNull();
    expect(stillWaiting.rider?.stopsAhead).toBeGreaterThan(0);
  });

  it('hands over, and the run closes itself when the last door is done', async () => {
    let sheet = await ops.tripSheet(TOKEN);
    for (const stop of sheet.stops.filter((s) => !s.done)) {
      sheet = await ops.completeStop(TOKEN, stop.id);
    }

    expect(sheet.trip).toBeNull(); // no open run left
    const rows = await prisma.unsafeRaw.order.findMany({ where: { code: { in: ['FHTR001', 'FHTR002'] } } });
    expect(rows.map((r) => r.status)).toEqual(['DELIVERED', 'DELIVERED']);
  });

  it('refuses a stop on somebody else’s run', async () => {
    const other = await prisma.unsafeRaw.rider.create({
      data: { name: 'Other', phone: '01700000202', token: 'other-trip-token' },
    });
    const fresh = await order(kitchen, 'FHTR010', 'Bazar');
    await ops.acceptWork(TOKEN, fresh.id);
    const { stops } = await ops.tripSheet(TOKEN);

    await expect(ops.completeStop('other-trip-token', stops[0].id)).rejects.toThrow(/not on your run/i);
    expect(other.id).not.toBe(riderId);
  });
});
