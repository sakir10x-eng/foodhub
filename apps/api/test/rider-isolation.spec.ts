import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service';
import { CacheService } from '../src/infra/cache.service';
import { OpsService } from '../src/ops/ops.service';
import { TenantContext } from '../src/common/tenant-context';

/**
 * A rider's token is a working delivery link.
 *
 * Anyone holding it can open the run sheet and read every customer that rider is
 * carrying: full address, phone number, and the exact cash to be handed over at the door.
 * That makes the rider list a more dangerous thing to leak than the order list.
 *
 * It also makes a **shared** rider a security problem rather than just a data model. Once
 * one person can carry for several shops, a shop that could add a rider by typing their
 * phone number would be handed a link into every other shop that rider works for. The
 * invitation — pending until the rider themselves accepts, from the sheet they already
 * hold — is what closes that, and most of this file exists to prove it stays closed.
 *
 * `Rider` and `RiderShop` sit outside the tenant guard on purpose (a rider has no single
 * tenantId), so unlike every other model here nothing is filtering them automatically.
 * These tests are the only thing standing behind that decision.
 */
describe('rider isolation between shops', () => {
  const prisma = new PrismaService();
  const ops = new OpsService(prisma, new CacheService(new ConfigService({})));

  let alpha: string;
  let beta: string;
  let alphaRider: string;
  let alphaOrder: string;
  let betaOrder: string;
  const ALPHA_RIDER_TOKEN = 'alpha-rider-token';

  const orderFor = (tenantId: string, code: string) =>
    prisma.unsafeRaw.order.create({
      data: {
        tenantId,
        code,
        channel: 'OWN_STORE',
        customerPhone: '01711111111',
        status: 'READY',
        subtotal: 20_000,
        deliveryFee: 6_000,
        total: 26_000,
        deliveryAddress: {},
      },
    });

  beforeAll(async () => {
    await prisma.onModuleInit();
    await prisma.truncateAll();

    const [a, b] = await Promise.all([
      prisma.unsafeRaw.tenant.create({ data: { slug: 'alpha-kitchen', name: 'Alpha Kitchen' } }),
      prisma.unsafeRaw.tenant.create({ data: { slug: 'beta-grocers', name: 'Beta Grocers' } }),
    ]);
    alpha = a.id;
    beta = b.id;

    const rider = await prisma.unsafeRaw.rider.create({
      data: {
        name: 'Rakib',
        phone: '01700000011',
        token: ALPHA_RIDER_TOKEN,
        shops: { create: { tenantId: alpha, approved: true, approvedAt: new Date() } },
      },
    });
    alphaRider = rider.id;

    alphaOrder = (await orderFor(alpha, 'FHISO001')).id;
    betaOrder = (await orderFor(beta, 'FHISO002')).id;
  });

  afterAll(() => prisma.onModuleDestroy());

  describe('listing riders', () => {
    it('shows a shop only the riders who carry for it', async () => {
      const mine = await ops.listRiders(alpha);
      expect(mine.map((r) => r.name)).toEqual(['Rakib']);

      const theirs = await ops.listRiders(beta);
      expect(theirs).toHaveLength(0);
    });
  });

  describe('a shop cannot help itself to another shop’s rider', () => {
    it('adding a known phone number creates an invitation, not a hire', async () => {
      const result = await ops.addRider(beta, 'Rakib', '01700000011');
      expect(result.invited).toBe(true);
      expect(result.approved).toBe(false);
    });

    // This is the whole point. Knowing a phone number must not buy you a link into every
    // shop that rider already works for.
    it('withholds the token while the invitation is unanswered', async () => {
      const result = await ops.addRider(beta, 'Rakib', '01700000011').catch((e) => e);
      // (a second add is refused; the listing is what matters)
      const listed = await ops.listRiders(beta);
      expect(listed).toHaveLength(1);
      expect(listed[0].approved).toBe(false);
      expect(listed[0].token).toBeNull();
      expect(result).toBeInstanceOf(Error);
    });

    it('refuses to let the inviting shop assign them meanwhile', async () => {
      await expect(
        TenantContext.runAsTenant(beta, () => ops.assignRider(beta, betaOrder, alphaRider)),
      ).rejects.toThrow();

      const order = await prisma.unsafeRaw.order.findUnique({ where: { id: betaOrder } });
      expect(order!.riderId).toBeNull();
    });

    it('keeps the inviting shop off the rider’s sheet until they say yes', async () => {
      await prisma.unsafeRaw.order.update({
        where: { id: betaOrder },
        data: { riderId: alphaRider, status: 'ON_THE_WAY' },
      });

      const queue = await ops.riderQueue(ALPHA_RIDER_TOKEN);
      // Even with the order pointed straight at them, an unapproved shop contributes
      // nothing — the approved-shop filter is what is being tested, not the assignment.
      expect(queue.orders.map((o) => o.code)).not.toContain('FHISO002');
      expect(queue.invites.map((i) => i.store)).toEqual(['Beta Grocers']);
    });
  });

  describe('the rider answering', () => {
    it('declining removes the invitation and changes nothing else', async () => {
      await ops.respondToInvite(ALPHA_RIDER_TOKEN, beta, false);
      expect(await ops.listRiders(beta)).toHaveLength(0);

      const queue = await ops.riderQueue(ALPHA_RIDER_TOKEN);
      expect(queue.invites).toHaveLength(0);
      expect(queue.orders.map((o) => o.code)).not.toContain('FHISO002');
    });

    it('accepting opens exactly one shop, and the sheet spans both', async () => {
      await ops.addRider(beta, 'Rakib', '01700000011');
      await ops.respondToInvite(ALPHA_RIDER_TOKEN, beta, true);

      await TenantContext.runAsTenant(alpha, () => ops.assignRider(alpha, alphaOrder, alphaRider));

      const queue = await ops.riderQueue(ALPHA_RIDER_TOKEN);
      expect(queue.orders.map((o) => o.code).sort()).toEqual(['FHISO001', 'FHISO002']);
      // Each drop says which counter it came from — a rider carrying for two shops cannot
      // pick anything up without that.
      expect(queue.orders.map((o) => o.store).sort()).toEqual(['Alpha Kitchen', 'Beta Grocers']);
      expect(queue.rider).toEqual({ name: 'Rakib', shops: 2 });
    });

    it('now hands the token to the shop that was accepted', async () => {
      const listed = await ops.listRiders(beta);
      expect(listed[0].approved).toBe(true);
      expect(listed[0].token).toBe(ALPHA_RIDER_TOKEN);
    });

    it('refuses an invitation answered with a token that is not a rider', async () => {
      await expect(ops.respondToInvite('not-a-real-token', alpha, true)).rejects.toThrow();
    });
  });

  describe('parting ways', () => {
    it('ends one shop’s relationship without touching the other', async () => {
      await ops.removeRider(beta, alphaRider);

      const queue = await ops.riderQueue(ALPHA_RIDER_TOKEN);
      // Beta's order is off the sheet; Alpha's is untouched.
      expect(queue.orders.map((o) => o.code)).toEqual(['FHISO001']);
      expect(queue.rider.shops).toBe(1);

      // The person survives, because the delivery they already made still points at them.
      const rider = await prisma.unsafeRaw.rider.findUnique({ where: { id: alphaRider } });
      expect(rider).not.toBeNull();
    });

    it('takes the released rider off that shop’s live orders', async () => {
      const order = await prisma.unsafeRaw.order.findUnique({ where: { id: betaOrder } });
      expect(order!.riderId).toBeNull();
    });

    it('refuses to release a rider who never worked there', async () => {
      await expect(ops.removeRider(beta, alphaRider)).rejects.toThrow();
    });
  });

  describe('position reporting', () => {
    it('counts only deliveries at shops the rider is cleared for', async () => {
      await prisma.unsafeRaw.order.update({
        where: { id: alphaOrder },
        data: { status: 'ON_THE_WAY' },
      });
      // Beta is no longer an approved shop, and this order is deliberately left pointing
      // at the rider to prove the filter — not the assignment — is what excludes it.
      await prisma.unsafeRaw.order.update({
        where: { id: betaOrder },
        data: { riderId: alphaRider, status: 'ON_THE_WAY' },
      });

      const result = await ops.reportRiderLocation({
        token: ALPHA_RIDER_TOKEN,
        lat: 23.7461,
        lng: 90.3742,
        accuracy: 10,
      });

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.orders).toBe(1);
        expect(result.live.map((o) => o.code)).toEqual(['FHISO001']);
      }
    });
  });
});
