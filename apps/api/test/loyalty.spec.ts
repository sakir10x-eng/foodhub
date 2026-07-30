import { PrismaService } from '../src/prisma/prisma.service';
import { LoyaltyService, normalizePhone } from '../src/loyalty/loyalty.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * Loyalty is money, so the invariants that matter are the ones that stop it being
 * minted or double-spent:
 *   - points are awarded on DELIVERED, once, and never at checkout;
 *   - redemption can never exceed the balance or the goods value;
 *   - one vendor's points are worthless at another vendor.
 */
describe('loyalty', () => {
  const prisma = new PrismaService();
  const loyalty = new LoyaltyService(prisma);

  let tenantId: string;
  let otherTenantId: string;
  const PHONE = '01711223344';

  const makeOrder = (over: Record<string, any> = {}, tid = tenantId) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId: tid,
        code: `FH${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        channel: 'OWN_STORE',
        customerPhone: PHONE,
        subtotal: 100_000, // ৳1000
        deliveryFee: 6_000,
        discount: 0,
        total: 106_000,
        deliveryAddress: {},
        ...over,
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();
    const [a, b] = await Promise.all([
      prisma.unsafeRaw.tenant.create({
        data: { slug: 'loyal-one', name: 'Loyal One', loyaltyEnabled: true, pointsPerHundred: 2, pointValue: 100, minRedeemPoints: 10 },
      }),
      prisma.unsafeRaw.tenant.create({
        data: { slug: 'loyal-two', name: 'Loyal Two', loyaltyEnabled: true },
      }),
    ]);
    tenantId = a.id;
    otherTenantId = b.id;
  });

  afterAll(() => prisma.onModuleDestroy());

  it('normalises phones to the last 10 digits', () => {
    expect(normalizePhone('+8801711223344')).toBe('1711223344');
    expect(normalizePhone('01711223344')).toBe('1711223344');
    expect(normalizePhone('01711-223344')).toBe('1711223344');
  });

  it('awards points on delivery at the vendor’s rate', async () => {
    const order = await makeOrder();
    const points = await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => loyalty.awardForDelivery(tx, tenantId, order)),
    );
    // ৳1000 of goods at 2 points per ৳100.
    expect(points).toBe(20);

    const balance = await loyalty.balance(tenantId, PHONE);
    expect(balance.points).toBe(20);
    expect(balance.lifetimePoints).toBe(20);
  });

  // The order row carries pointsEarned, so a replayed DELIVERED webhook is a no-op.
  it('is idempotent — a replayed delivery awards nothing twice', async () => {
    const order = await makeOrder({ pointsEarned: 20 });
    const points = await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => loyalty.awardForDelivery(tx, tenantId, order)),
    );
    expect(points).toBe(0);
    expect((await loyalty.balance(tenantId, PHONE)).points).toBe(20);
  });

  it('never awards points for a vendor with loyalty switched off', async () => {
    await prisma.unsafeRaw.tenant.update({ where: { id: otherTenantId }, data: { loyaltyEnabled: false } });
    const order = await makeOrder({}, otherTenantId);
    const points = await TenantContext.runAsTenant(otherTenantId, () =>
      prisma.db.$transaction((tx) => loyalty.awardForDelivery(tx, otherTenantId, order)),
    );
    expect(points).toBe(0);
  });

  it('quotes a redemption capped at the goods value, never the delivery fee', async () => {
    // 20 points × ৳1 = ৳20 of value, against a ৳10 subtotal.
    const quote = await loyalty.quoteRedemption(tenantId, PHONE, 1_000, 20, false);
    expect(quote.discount).toBe(1_000);
    expect(quote.pointsUsed).toBe(10); // only the points that actually bought something
  });

  it('cannot redeem more points than the balance', async () => {
    const quote = await loyalty.quoteRedemption(tenantId, PHONE, 100_000, 9999, false);
    expect(quote.pointsUsed).toBe(20);
    expect(quote.discount).toBe(2_000);
  });

  it('refuses to redeem below the vendor’s minimum', async () => {
    await prisma.unsafeRaw.tenant.update({ where: { id: tenantId }, data: { minRedeemPoints: 500 } });
    const quote = await loyalty.quoteRedemption(tenantId, PHONE, 100_000, 20, false);
    expect(quote.pointsUsed).toBe(0);
    await prisma.unsafeRaw.tenant.update({ where: { id: tenantId }, data: { minRedeemPoints: 10 } });
  });

  it('rejects a spend larger than the balance inside the transaction', async () => {
    const order = await makeOrder();
    await expect(
      TenantContext.runAsTenant(tenantId, () =>
        prisma.db.$transaction((tx) => loyalty.spend(tx, tenantId, PHONE, order.id, 999, 0)),
      ),
    ).rejects.toThrow();
    // The balance is untouched by the failed attempt.
    expect((await loyalty.balance(tenantId, PHONE)).points).toBe(20);
  });

  it('debits points and records the transaction', async () => {
    const order = await makeOrder();
    await TenantContext.runAsTenant(tenantId, () =>
      prisma.db.$transaction((tx) => loyalty.spend(tx, tenantId, PHONE, order.id, 15, 0)),
    );
    expect((await loyalty.balance(tenantId, PHONE)).points).toBe(5);

    const history = await loyalty.history(tenantId, PHONE);
    expect(history[0].type).toBe('REDEEM');
    expect(history[0].points).toBe(-15);
  });

  it('grants store credit that is spendable', async () => {
    await loyalty.grantCredit(tenantId, PHONE, 5_000, 'Apology for a late order');
    const balance = await loyalty.balance(tenantId, PHONE);
    expect(balance.wallet).toBe(5_000);

    const quote = await loyalty.quoteRedemption(tenantId, PHONE, 100_000, 0, true);
    expect(quote.walletUsed).toBe(5_000);
  });

  // Loyalty is per-vendor: the vendor funds the reward, so it cannot be spent elsewhere.
  it('keeps one vendor’s points worthless at another vendor', async () => {
    const atOther = await loyalty.balance(otherTenantId, PHONE);
    expect(atOther.points).toBe(0);
    expect(atOther.wallet).toBe(0);
  });
});
