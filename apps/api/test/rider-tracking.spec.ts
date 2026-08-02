import { ConfigService } from '@nestjs/config';
import {
  RIDER_FIX_MAX_AGE_MS,
  isFixFresh,
  riderVisibleFor,
  type OrderStatus,
} from '@foodhub/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import { RiderLedgerService } from '../src/rider-ledger/rider-ledger.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { OrdersService, toDto } from '../src/orders/orders.service';
import { LedgerService } from '../src/ledger/ledger.service';
import { LoyaltyService } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Live rider tracking is a privacy feature wearing a map.
 *
 * Everything worth testing here is about who can see a named worker's position and for
 * how long — not about geometry. The rules live in @foodhub/shared so the API and the UI
 * cannot drift apart; these tests pin both the rules and the wiring that applies them.
 */
describe('rider tracking rules', () => {
  it('shows a rider only while the food is actually on its way', () => {
    const seen: OrderStatus[] = ['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'ON_THE_WAY', 'DELIVERED'];
    expect(seen.filter(riderVisibleFor)).toEqual(['ON_THE_WAY']);
  });

  it('deliberately excludes READY — that rider is still on somebody else’s drop', () => {
    expect(riderVisibleFor('READY')).toBe(false);
  });

  it('treats a fix as stale past the age limit', () => {
    const now = Date.now();
    expect(isFixFresh(new Date(now - 1_000), now)).toBe(true);
    expect(isFixFresh(new Date(now - RIDER_FIX_MAX_AGE_MS + 1_000), now)).toBe(true);
    expect(isFixFresh(new Date(now - RIDER_FIX_MAX_AGE_MS - 1_000), now)).toBe(false);
    expect(isFixFresh(null, now)).toBe(false);
    expect(isFixFresh(undefined, now)).toBe(false);
  });
});

describe('rider position, end to end', () => {
  const prisma = new PrismaService();
  const riderLedger = new RiderLedgerService(prisma);
  const ops = new OpsService(prisma, new CacheService(new ConfigService({})), {} as any, riderLedger);
  const orders = new OrdersService(
    prisma,
    new LedgerService(prisma),
    riderLedger,
    new LoyaltyService(prisma),
    { enqueue: async () => undefined } as any,
    { emitOrderUpdate: () => undefined, emitNewOrder: () => undefined } as any,
    { settleOnDelivery: async () => undefined } as any,
  );

  let tenantId: string;
  let riderId: string;
  let riderToken: string;
  const PHONE = '01711223344';
  const DHANMONDI = { lat: 23.7461, lng: 90.3742 };

  const makeOrder = (status: OrderStatus, over: Record<string, any> = {}) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId,
        code: `FH${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        channel: 'OWN_STORE',
        customerPhone: PHONE,
        status,
        riderId,
        subtotal: 100_000,
        deliveryFee: 6_000,
        total: 106_000,
        commissionAmount: 0,
        deliveryAddress: { phone: PHONE, lat: 23.75, lng: 90.38 },
        ...over,
      },
    });

  const readBack = (code: string) =>
    TenantContext.runAsTenant(tenantId, async () => {
      const row = await prisma.db.order.findUnique({
        where: { code },
        include: { items: true, rider: { select: { name: true, phone: true, lat: true, lng: true, locationAt: true } } },
      });
      return toDto(row);
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();
    const tenant = await prisma.unsafeRaw.tenant.create({
      data: { slug: 'rider-test', name: 'Rider Test' },
    });
    tenantId = tenant.id;
    const rider = await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Rakib',
        phone: '01700000001',
        token: 'test-rider-token-abcdef',
        shops: { create: { tenantId, approved: true, approvedAt: new Date() } },
      },
    });
    riderId = rider.id;
    riderToken = rider.token;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('refuses a position from a token that is not a rider', async () => {
    await expect(ops.reportRiderLocation({ token: 'nope-nope-nope', ...DHANMONDI })).rejects.toThrow(
      /no longer valid/i,
    );
  });

  it('drops a fix too vague to be a location', async () => {
    const result = await ops.reportRiderLocation({ ...DHANMONDI, token: riderToken, accuracy: 5_000 });
    expect(result.accepted).toBe(false);

    const rider = await prisma.unsafeRaw.rider.findUnique({ where: { id: riderId } });
    // Nothing stored: a district drawn as a dot is a lie with a decimal point on it.
    expect(rider?.lat).toBeNull();
  });

  it('stores a good fix and reports who it reached', async () => {
    const onRoad = await makeOrder('ON_THE_WAY');
    const result = await ops.reportRiderLocation({ ...DHANMONDI, token: riderToken, accuracy: 12 });

    expect(result.accepted).toBe(true);
    expect(result.orders).toBe(1);
    if (result.accepted) expect(result.live[0].code).toBe(onRoad.code);
  });

  it('gives the customer the position once it is on the way', async () => {
    const order = await makeOrder('ON_THE_WAY');
    await ops.reportRiderLocation({ ...DHANMONDI, token: riderToken, accuracy: 10 });

    const dto = await readBack(order.code);
    expect(dto.rider?.name).toBe('Rakib');
    expect(dto.rider?.lat).toBeCloseTo(DHANMONDI.lat, 4);
    expect(dto.destination).toEqual({ lat: 23.75, lng: 90.38 });
  });

  it('tells a customer NOTHING about the rider before the food leaves', async () => {
    const order = await makeOrder('READY');
    await ops.reportRiderLocation({ ...DHANMONDI, token: riderToken, accuracy: 10 });

    const dto = await readBack(order.code);
    // Not a redacted position — no rider block at all.
    expect(dto.rider).toBeNull();
    // The vendor still needs to know somebody is assigned.
    expect(dto.riderId).toBe(riderId);
  });

  it('withholds a stale position but still offers the phone number', async () => {
    const order = await makeOrder('ON_THE_WAY');
    await prisma.unsafeRaw.rider.update({
      where: { id: riderId },
      data: { lat: DHANMONDI.lat, lng: DHANMONDI.lng, locationAt: new Date(Date.now() - RIDER_FIX_MAX_AGE_MS - 60_000) },
    });

    const dto = await readBack(order.code);
    expect(dto.rider?.name).toBe('Rakib');
    expect(dto.rider?.phone).toBe('01700000001');
    // A frozen pin is worse than no pin — the customer believes it.
    expect(dto.rider?.lat).toBeNull();
    expect(dto.rider?.locationAt).toBeNull();
  });

  it('stops sharing the moment the order is delivered', async () => {
    const order = await makeOrder('ON_THE_WAY');
    await ops.reportRiderLocation({ ...DHANMONDI, token: riderToken, accuracy: 10 });
    expect((await readBack(order.code)).rider?.lat).not.toBeNull();

    await TenantContext.runAsTenant(tenantId, () => orders.updateStatus(order.id, 'DELIVERED', 'test'));
    expect((await readBack(order.code)).rider).toBeNull();
  });

  it('reports zero recipients when nothing is on the road', async () => {
    await prisma.unsafeRaw.order.updateMany({ where: { tenantId }, data: { status: 'DELIVERED' } });
    const result = await ops.reportRiderLocation({ ...DHANMONDI, token: riderToken, accuracy: 10 });
    expect(result.orders).toBe(0);
  });
});
