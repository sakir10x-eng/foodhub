import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import {
  DELIVERY_OTP_MAX_ATTEMPTS,
  RIDER_FIX_MAX_ACCURACY_M,
  deliveryOtpMatches,
  planStops,
  riderCoversDelivery,
  type AttemptFailReason,
  type DeliveryTarget,
  type GeoPoint,
  type GeoShape,
  type StopKind,
} from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { CacheService } from '../infra/cache.service';
import { OrdersService } from '../orders/orders.service';
import { RiderLedgerService, overCashLimit } from '../rider-ledger/rider-ledger.service';

export interface OpeningHour {
  /** 0 = Sunday. Bangladesh's week starts on Sunday, and so does this. */
  day: number;
  open: string;
  close: string;
}

/**
 * The unglamorous half of running a kitchen: when it is open, who is carrying the food,
 * and what has run out.
 *
 * None of this increases an order's value. All of it stops orders being cancelled, which
 * is worth more — a cancelled order costs the food, the rider, the refund and the rating.
 */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    // Injected rather than reimplemented: DELIVERED is where settlement, loyalty and the
    // customer's text all hang off, and a rider marking a drop done must take exactly the
    // same path a vendor does. See completeStop.
    private readonly orders: OrdersService,
    // The rider's cash position gates what work they are offered, and their own screen
    // shows it back to them. See availableWork and riderMoney.
    private readonly riderLedger: RiderLedgerService,
  ) {}

  /* ────────────────────────────────────────────────── opening hours */

  /**
   * Flip every vendor's open flag to match their schedule.
   *
   * Runs every five minutes on Dhaka wall-clock time, because "we close at 11pm" means
   * 11pm in Dhaka — not wherever the server happens to be. Vendors who have not set a
   * schedule, or who have auto-open switched off, are left entirely alone: an automatic
   * system that overrides a manual switch is worse than no automation.
   */
  @Cron('*/5 * * * *')
  async applyOpeningHours() {
    const tenants = await TenantContext.runAsPlatform('opening hours sweep every vendor', () =>
      this.prisma.db.tenant.findMany({
        where: { autoOpenClose: true },
        select: { id: true, slug: true, isOpen: true, openingHours: true },
      }),
    );

    const { day, minutes } = dhakaNow();
    let flipped = 0;

    for (const tenant of tenants) {
      const hours = (tenant.openingHours ?? []) as unknown as OpeningHour[];
      if (hours.length === 0) continue;

      const shouldBeOpen = isOpenAt(hours, day, minutes);
      if (shouldBeOpen === tenant.isOpen) continue;

      await TenantContext.runAsTenant(tenant.id, () =>
        this.prisma.db.tenant.update({ where: { id: tenant.id }, data: { isOpen: shouldBeOpen } }),
      );
      await this.cache.delByPrefix(`menu:${tenant.id}`);
      await this.cache.delByPrefix('marketplace:');
      flipped++;
      this.logger.log(`${tenant.slug} auto-${shouldBeOpen ? 'opened' : 'closed'}`);
    }

    if (flipped) this.logger.log(`Opening hours: flipped ${flipped}`);
  }

  async setOpeningHours(tenantId: string, hours: OpeningHour[], autoOpenClose: boolean) {
    for (const h of hours) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.open) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.close)) {
        throw new BadRequestException('Use 24-hour times like 10:00 and 23:00');
      }
    }
    await this.prisma.db.tenant.update({
      where: { id: tenantId },
      data: { openingHours: hours as any, autoOpenClose },
    });
    await this.cache.delByPrefix(`menu:${tenantId}`);
    return { ok: true };
  }

  /* ─────────────────────────────────────────────────────── 86'ing */

  /**
   * "Sold out for today" — with a date, so it comes back on its own.
   *
   * The permanent toggle already exists; this is the one a kitchen actually uses at 8pm,
   * and the one they forget to undo. Setting a return time is what stops a dish silently
   * vanishing from the menu for a month.
   */
  async markSoldOut(productId: string, untilTomorrow: boolean) {
    const product = await this.prisma.db.product.findUnique({ where: { id: productId }, select: { id: true } });
    if (!product) throw new NotFoundException('Menu item not found');

    const until = untilTomorrow ? nextDhakaMidnight() : null;
    await this.prisma.db.product.update({
      where: { id: productId },
      data: { isAvailable: false, soldOutUntil: until },
    });
    return { soldOutUntil: until };
  }

  /** Restores everything whose "sold out for today" has expired. Runs just after midnight. */
  @Cron('5 18 * * *') // 18:05 UTC = 00:05 Asia/Dhaka
  async restoreSoldOut() {
    const restored = await TenantContext.runAsPlatform('sold-out restore sweeps every vendor', () =>
      this.prisma.db.product.updateMany({
        where: { isAvailable: false, soldOutUntil: { not: null, lte: new Date() } },
        data: { isAvailable: true, soldOutUntil: null },
      }),
    );
    if (restored.count > 0) {
      await this.cache.delByPrefix('menu:');
      await this.cache.delByPrefix('marketplace:');
      this.logger.log(`Restored ${restored.count} sold-out items`);
    }
  }

  /* ───────────────────────────────────────────────────────── riders */

  /**
   * The shops a rider actually carries for.
   *
   * `Rider` and `RiderShop` are outside the tenant guard (see UNGUARDED_MODELS), so this
   * filter is not a convenience — it is the entire access control for everything below it.
   * Every rider read in this file goes through here or repeats it verbatim.
   */
  private approvedShopIds(riderId: string): Promise<string[]> {
    return this.prisma.db.riderShop
      .findMany({ where: { riderId, approved: true }, select: { tenantId: true } })
      .then((rows) => rows.map((r) => r.tenantId));
  }

  /**
   * The riders one shop can point at an order, plus anyone it has invited and is waiting
   * on.
   *
   * A pending rider is listed by name so the vendor knows the invitation was sent, but
   * **their token is withheld until they accept**. The token is a working delivery link
   * into every shop that rider carries for; handing it over on the strength of knowing a
   * phone number would rebuild the leak this model was designed to close.
   */
  async listRiders(tenantId: string) {
    const links = await this.prisma.db.riderShop.findMany({
      where: { tenantId, rider: { isActive: true } },
      orderBy: { rider: { name: 'asc' } },
      select: {
        approved: true,
        rider: { select: { id: true, name: true, phone: true, token: true } },
      },
    });

    return links.map((link) => ({
      id: link.rider.id,
      name: link.rider.name,
      phone: link.rider.phone,
      approved: link.approved,
      token: link.approved ? link.rider.token : null,
    }));
  }

  /**
   * Take on a rider.
   *
   * Two different things wear one button here, and the difference is the security model:
   *
   *   - a phone number nobody has seen before is a new person, created and approved on the
   *     spot — there is no one to ask, and the shop vouching for them is the whole story;
   *   - a phone number that already rides for another shop is an **invitation**. The link
   *     is created unapproved and the rider turns it on from the sheet they already hold.
   *
   * Without the second case a vendor could type a rider's number, be handed their token,
   * and read every other shop's customers off that rider's sheet.
   */
  async addRider(tenantId: string, name: string, phone: string) {
    const existing = await this.prisma.db.rider.findUnique({
      where: { phone },
      select: { id: true, name: true, phone: true, token: true, isActive: true },
    });

    if (!existing) {
      const rider = await this.prisma.db.rider.create({
        // The token addresses the rider's own view, so it is random rather than derived —
        // a guessable one would expose every customer's address to anyone.
        data: {
          name,
          phone,
          token: randomBytes(16).toString('base64url'),
          shops: { create: { tenantId, approved: true, approvedAt: new Date() } },
        },
        select: { id: true, name: true, phone: true, token: true },
      });
      return { ...rider, approved: true, invited: false };
    }

    // A rider who left the platform entirely is not re-enrolled behind their back.
    if (!existing.isActive) throw new BadRequestException('This rider is no longer available');

    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId: existing.id, tenantId } },
      select: { approved: true },
    });
    if (link?.approved) throw new BadRequestException('This rider already works with you');
    if (link) throw new BadRequestException('This rider has already been invited — waiting for them to accept');

    await this.prisma.db.riderShop.create({ data: { riderId: existing.id, tenantId, approved: false } });
    return {
      id: existing.id,
      name: existing.name,
      phone: existing.phone,
      token: null,
      approved: false,
      invited: true,
    };
  }

  /**
   * Stop working with a rider.
   *
   * This ends the relationship, not the person: the rider row survives because past orders
   * point at it, and a delivery with no record of who carried it is exactly what you need
   * on the day something goes wrong. They may also still be riding for three other shops,
   * none of whose business this is.
   */
  async removeRider(tenantId: string, riderId: string) {
    const removed = await this.prisma.db.riderShop.deleteMany({ where: { riderId, tenantId } });
    if (removed.count === 0) throw new NotFoundException('Rider not found');

    // Their sheet must not keep showing this shop's deliveries after they have been let
    // go. Unassigning is the guarded-client write, so it cannot reach another shop's rows.
    await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.order.updateMany({
        where: { riderId, status: { notIn: ['DELIVERED', 'CANCELLED', 'REFUNDED'] } },
        data: { riderId: null },
      }),
    );
    return { ok: true };
  }

  async assignRider(tenantId: string, orderId: string, riderId: string | null) {
    const order = await this.prisma.db.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found');

    // `riderId` arrives from the client, and riders are no longer filtered by the guard —
    // so this check is the only thing stopping a shop handing its delivery to a rider who
    // does not work for them, whose sheet would then show this shop's customer.
    if (riderId) {
      const link = await this.prisma.db.riderShop.findUnique({
        where: { riderId_tenantId: { riderId, tenantId } },
        select: { approved: true, rider: { select: { isActive: true } } },
      });
      if (!link?.approved || !link.rider.isActive) throw new NotFoundException('Rider not found');
    }

    await this.prisma.db.order.update({ where: { id: orderId }, data: { riderId } });

    // A shop handing work out by name puts it on the same run as work the rider took
    // themselves. Two lists for one afternoon is how a parcel gets left at a counter.
    if (riderId) await this.addToTrip(riderId, tenantId, orderId);
    return { ok: true };
  }

  /** A rider resolved from their own link, with the shops they are cleared to carry for. */
  private async riderByToken(token: string) {
    const rider = await this.prisma.db.rider.findUnique({
      where: { token },
      select: { id: true, name: true, isActive: true, onDuty: true, lat: true, lng: true },
    });
    if (!rider || !rider.isActive) throw new NotFoundException('This delivery link is no longer valid');
    return rider;
  }

  /**
   * What one rider is carrying, across every shop they work for. Addressed by their token,
   * not by a login.
   *
   * The orders are read **one shop at a time under `runAsTenant`** rather than in a single
   * cross-tenant query. A single query would have to run in platform scope, where a
   * `tenantId: { in: [...] }` filter is the only thing between this rider and every order
   * in the database — one editing mistake from a total breach. A village rider works for a
   * handful of shops, so the loop costs a handful of indexed lookups and keeps the guard
   * switched on for each one. That trade is deliberate; do not "optimise" it into one call.
   */
  async riderQueue(token: string) {
    const rider = await this.riderByToken(token);

    const [shopIds, invites] = await Promise.all([
      this.approvedShopIds(rider.id),
      this.pendingInvites(rider.id),
    ]);

    const perShop = await Promise.all(
      shopIds.map((tenantId) =>
        TenantContext.runAsTenant(tenantId, async () => {
          const [shop, orders] = await Promise.all([
            this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
            this.prisma.db.order.findMany({
              where: { riderId: rider.id, status: { in: ['READY', 'ON_THE_WAY'] } },
              orderBy: { placedAt: 'asc' },
              select: {
                id: true, code: true, status: true, total: true, dueOnDelivery: true,
                deliveryAddress: true, customerPhone: true, placedAt: true,
              },
            }),
          ]);
          // The shop's name travels with each drop: a rider carrying for three shops needs
          // to know which counter this one came from before they can pick it up.
          return orders.map((order) => ({ ...order, store: shop?.name ?? '' }));
        }),
      ),
    );

    const orders = perShop
      .flat()
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());

    return { rider: { name: rider.name, shops: shopIds.length }, orders, invites };
  }

  /* ──────────────────────────────────────────────────── duty, areas, and the job pool */

  /**
   * The rider going on or off the road.
   *
   * Coming off duty does **not** drop the deliveries they are already carrying — those are
   * a promise made to a customer with food in a bag, and only a human can undo that. It
   * stops new work being offered, which is the thing a rider actually needs at the end of
   * a shift.
   */
  async setDuty(token: string, onDuty: boolean) {
    const rider = await this.riderByToken(token);
    await this.prisma.db.rider.update({
      where: { id: rider.id },
      data: { onDuty, dutySince: onDuty ? new Date() : null },
    });
    return { onDuty };
  }

  /**
   * A shop setting up a rider's patch.
   *
   * The patch belongs to the **rider**, not to the relationship: one person has one
   * territory, and slicing it per shop would mean a rider covering "উত্তর পাড়া" for the
   * grocer and not for the tea stall next door, which describes nothing real. The
   * consequence is that any shop the rider has accepted can edit it — acceptable among a
   * handful of shops in one village, and worth revisiting the day that stops being true.
   *
   * A rider with no areas is offered nothing rather than everything; see
   * `riderCoversDelivery`.
   */
  async setAreas(tenantId: string, riderId: string, areas: { label: string; shape: GeoShape }[]) {
    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId, tenantId } },
      select: { approved: true },
    });
    if (!link?.approved) throw new NotFoundException('Rider not found');

    // Replaced wholesale rather than diffed: the vendor edits this as one list, and a
    // partial update that half-applied would leave a patch nobody intended.
    await this.prisma.db.$transaction([
      this.prisma.db.riderArea.deleteMany({ where: { riderId } }),
      ...areas.map((area) =>
        this.prisma.db.riderArea.create({ data: { riderId, label: area.label, shape: area.shape as any } }),
      ),
    ]);
    return this.listAreas(riderId);
  }

  async areasForShop(tenantId: string, riderId: string) {
    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId, tenantId } },
      select: { approved: true },
    });
    if (!link?.approved) throw new NotFoundException('Rider not found');
    return this.listAreas(riderId);
  }

  listAreas(riderId: string) {
    return this.prisma.db.riderArea.findMany({
      where: { riderId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, shape: true },
    });
  }

  /**
   * Deliveries waiting in this rider's patch, across every shop they carry for.
   *
   * Three things are withheld from an offer, and each one is a decision:
   *
   *   - **the street address**, until they accept. Any rider on duty can read this list,
   *     and a list of every doorstep in the village is not something to hand out for the
   *     price of switching a toggle on. The area name is enough to decide with.
   *   - **the customer's phone**, for the same reason.
   *   - anything they have already passed on, which would otherwise climb back to the top
   *     of the list every thirty seconds until they took it by accident.
   */
  async availableWork(token: string) {
    const rider = await this.riderByToken(token);
    if (!rider.onDuty) return { onDuty: false, offers: [] };

    const [shopIds, areas, skipped, money] = await Promise.all([
      this.approvedShopIds(rider.id),
      this.listAreas(rider.id),
      this.prisma.db.riderOfferSkip
        .findMany({ where: { riderId: rider.id }, select: { orderId: true } })
        .then((rows) => new Set(rows.map((r) => r.orderId))),
      this.riderLedger.balances(rider.id),
    ]);
    const shapes = areas.map((a) => a.shape as GeoShape);

    const perShop = await Promise.all(
      shopIds.map((tenantId) =>
        TenantContext.runAsTenant(tenantId, async () => {
          const [shop, orders] = await Promise.all([
            this.prisma.db.tenant.findUnique({
              where: { id: tenantId },
              select: { name: true, riderCashLimit: true },
            }),
            this.prisma.db.order.findMany({
              // CONFIRMED as well as READY: in a village the rider often has further to
              // travel than the kitchen has to cook, so waiting for READY to offer the job
              // means the food sits on the counter going cold.
              where: {
                riderId: null,
                fulfillment: 'DELIVERY',
                status: { in: ['CONFIRMED', 'PREPARING', 'READY'] },
              },
              orderBy: { placedAt: 'asc' },
              select: {
                id: true, code: true, status: true, dueOnDelivery: true,
                deliveryAddress: true, placedAt: true,
              },
            }),
          ]);

          // A rider already holding this shop's limit in cash is not offered more of it.
          // Prepaid work still is: the exposure being managed is the money on them, and
          // stopping their whole day over it would be a punishment rather than a control.
          const capped = overCashLimit(money.cash, shop?.riderCashLimit ?? 0);

          return orders
            .filter((order) => !skipped.has(order.id))
            .filter((order) => !(capped && order.dueOnDelivery > 0))
            .filter((order) => riderCoversDelivery(shapes, addressTarget(order.deliveryAddress)))
            .map((order) => ({
              id: order.id,
              code: order.code,
              status: order.status,
              store: shop?.name ?? '',
              area: (order.deliveryAddress as any)?.area ?? '',
              dueOnDelivery: order.dueOnDelivery,
              placedAt: order.placedAt,
            }));
        }),
      ),
    );

    const offers = perShop.flat().sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
    return { onDuty: true, offers };
  }

  /**
   * What the rider is holding and what they have earned.
   *
   * On their own screen because it is their money and the shop's money, and the person
   * carrying both is the one who has to account for it at the end of the day. A rider who
   * can only find out what they owe by asking is a rider who finds out they were wrong.
   */
  async riderMoney(token: string) {
    const rider = await this.riderByToken(token);
    const [balances, recent] = await Promise.all([
      this.riderLedger.balances(rider.id),
      this.riderLedger.statement(rider.id, 20),
    ]);
    return { ...balances, recent };
  }

  /**
   * A rider taking a delivery.
   *
   * Two riders tapping the same card at the same moment is the normal case, not the edge
   * case — everybody is looking at the same list. So the claim is a conditional update
   * that only matches while `riderId` is still null: exactly one of them changes a row,
   * and the other is told plainly rather than being left believing they have it.
   */
  async acceptWork(token: string, orderId: string) {
    const rider = await this.riderByToken(token);
    if (!rider.onDuty) throw new BadRequestException('Go on duty before taking a delivery');

    const tenantId = await this.tenantForOffer(rider.id, orderId);

    const claimed = await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.order.updateMany({
        where: { id: orderId, riderId: null, status: { in: ['CONFIRMED', 'PREPARING', 'READY'] } },
        data: { riderId: rider.id },
      }),
    );
    if (claimed.count === 0) throw new ConflictException('Someone else has taken this delivery');

    await this.addToTrip(rider.id, tenantId, orderId);
    return { ok: true };
  }

  /** Passing on a delivery. It stays fully available to every other rider. */
  async skipWork(token: string, orderId: string) {
    const rider = await this.riderByToken(token);
    await this.tenantForOffer(rider.id, orderId);

    await this.prisma.db.riderOfferSkip.upsert({
      where: { riderId_orderId: { riderId: rider.id, orderId } },
      create: { riderId: rider.id, orderId },
      update: {},
    });
    return { ok: true };
  }

  /* ─────────────────────────────────────────────────────────────────────────── the run */

  /**
   * Put an order into the rider's open run, creating one if they have none.
   *
   * Two stops go in together — the counter and the door — because a parcel that is only
   * half on the plan is a parcel the rider drives past. A run that has already started
   * still accepts new work: in a village a rider is routinely asked to grab one more thing
   * while they are out, and refusing that would send them back to the shop for nothing.
   */
  private async addToTrip(riderId: string, tenantId: string, orderId: string) {
    const trip =
      (await this.prisma.db.trip.findFirst({
        where: { riderId, status: { in: ['PLANNED', 'ACTIVE'] } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      })) ?? (await this.prisma.db.trip.create({ data: { riderId }, select: { id: true } }));

    const last = await this.prisma.db.tripStop.findFirst({
      where: { tripId: trip.id },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const base = (last?.seq ?? -1) + 1;

    // Appended in arrival order and left there. Re-sorting happens in `replanTrip`, which
    // the rider triggers — a plan that silently rearranges itself while somebody is riding
    // to a place is worse than a plan that is merely imperfect.
    await this.prisma.db.tripStop.createMany({
      data: [
        { tripId: trip.id, seq: base, kind: 'PICKUP', orderId, tenantId },
        { tripId: trip.id, seq: base + 1, kind: 'DROP', orderId, tenantId },
      ],
      skipDuplicates: true,
    });

    await this.advanceTrip(trip.id);
    return trip.id;
  }

  /**
   * Move the trip's pointer to the first stop that is still outstanding.
   *
   * The **only** writer of `Trip.activeSeq`, which is what the customer's tracker reads to
   * decide whether the rider is coming to them or to somebody else. Every path that
   * completes, adds or reorders a stop ends here, and a second writer appearing anywhere
   * else would make that field a guess.
   */
  private async advanceTrip(tripId: string) {
    const next = await this.prisma.db.tripStop.findFirst({
      where: { tripId, completedAt: null },
      orderBy: { seq: 'asc' },
      select: { seq: true },
    });

    if (!next) {
      await this.prisma.db.trip.updateMany({
        where: { id: tripId, status: { in: ['PLANNED', 'ACTIVE'] } },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      return;
    }
    await this.prisma.db.trip.update({ where: { id: tripId }, data: { activeSeq: next.seq } });
  }

  /**
   * Sort the outstanding stops into a sensible order and start riding.
   *
   * Completed stops are never touched: they are a record of where somebody has already
   * been, and rewriting history to make a plan tidier would break the one thing a run
   * sheet is for. Only what is still ahead gets reordered.
   */
  async planTrip(token: string) {
    const rider = await this.riderByToken(token);
    const trip = await this.openTrip(rider.id);
    if (!trip) throw new NotFoundException('You have no deliveries to plan');

    const stops = await this.prisma.db.tripStop.findMany({
      where: { tripId: trip.id },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, kind: true, orderId: true, tenantId: true, completedAt: true },
    });

    const done = stops.filter((s) => s.completedAt);
    const todo = stops.filter((s) => !s.completedAt);
    if (todo.length === 0) throw new BadRequestException('Every stop on this run is done');

    const points = await this.stopPoints(todo);
    const planned = planStops(
      todo.map((stop) => ({
        orderId: stop.orderId,
        kind: stop.kind as StopKind,
        tenantId: stop.tenantId,
        point: points.get(stop.id)?.point ?? null,
        placedAt: points.get(stop.id)?.placedAt ?? 0,
      })),
      riderPoint(rider),
    );

    // Matched back by (orderId, kind), the pair that is unique on a trip.
    const key = (s: { orderId: string; kind: string }) => `${s.orderId}:${s.kind}`;
    const rank = new Map(planned.map((s, index) => [key(s), index]));
    const resequenced = [...todo].sort((a, b) => (rank.get(key(a)) ?? 0) - (rank.get(key(b)) ?? 0));

    // Two passes into a scratch range: `(tripId, seq)` is unique, so writing the new
    // numbers directly would collide with the old ones halfway through.
    const offset = (done.length + todo.length) * 10 + 1000;
    await this.prisma.db.$transaction([
      ...resequenced.map((stop, index) =>
        this.prisma.db.tripStop.update({ where: { id: stop.id }, data: { seq: offset + index } }),
      ),
      ...resequenced.map((stop, index) =>
        this.prisma.db.tripStop.update({ where: { id: stop.id }, data: { seq: done.length + index } }),
      ),
      this.prisma.db.trip.update({
        where: { id: trip.id },
        data: { status: 'ACTIVE', startedAt: trip.startedAt ?? new Date() },
      }),
    ]);

    await this.advanceTrip(trip.id);
    return this.tripSheet(token);
  }

  /** Where each stop is, and when its order was placed. */
  private async stopPoints(stops: { id: string; kind: string; orderId: string; tenantId: string }[]) {
    const out = new Map<string, { point: { lat: number; lng: number } | null; placedAt: number }>();

    for (const stop of stops) {
      const { tenantId } = stop;
      await TenantContext.runAsTenant(tenantId, async () => {
        const order = await this.prisma.db.order.findUnique({
          where: { id: stop.orderId },
          select: { deliveryAddress: true, placedAt: true },
        });
        if (!order) return;

        if (stop.kind === 'PICKUP') {
          const shop = await this.prisma.db.tenant.findUnique({
            where: { id: tenantId },
            select: { lat: true, lng: true },
          });
          out.set(stop.id, {
            point: shop?.lat != null && shop?.lng != null ? { lat: shop.lat, lng: shop.lng } : null,
            placedAt: order.placedAt.getTime(),
          });
        } else {
          out.set(stop.id, {
            point: addressTarget(order.deliveryAddress).point ?? null,
            placedAt: order.placedAt.getTime(),
          });
        }
      });
    }
    return out;
  }

  /**
   * The rider marking a stop done — collected at a counter, or handed over at a door.
   *
   * The order's status is moved through **`OrdersService.updateStatus`**, never by writing
   * the column here. DELIVERED is where settlement posts, loyalty points are awarded and
   * the customer is texted; a second path that only set `status` would look right on the
   * screen and quietly skip the money. The one thing written directly is `pickedUpAt`,
   * which no other code owns.
   */
  async completeStop(token: string, stopId: string, otp?: string) {
    const rider = await this.riderByToken(token);
    const stop = await this.stopOnMyRun(rider.id, stopId);
    if (stop.completedAt) return this.tripSheet(token);

    // Out of order is refused. A rider who marks the third drop done from the first one's
    // gate leaves two customers whose tracker says delivered and whose food is in a bag.
    const earlier = await this.prisma.db.tripStop.findFirst({
      where: { tripId: stop.tripId, completedAt: null, seq: { lt: await this.seqOf(stop.id) } },
      select: { id: true },
    });
    if (earlier) throw new BadRequestException('Finish the stop before this one first');

    if (stop.kind === 'PICKUP') {
      await TenantContext.runAsTenant(stop.tenantId, async () => {
        const order = await this.prisma.db.order.findUnique({
          where: { id: stop.orderId },
          select: { status: true },
        });
        if (!order) throw new NotFoundException('Order not found');
        // Nothing may be collected before the kitchen says it is ready — a rider who takes
        // a bag that is not packed is the origin of half of all missing-item complaints.
        if (order.status === 'CONFIRMED' || order.status === 'PREPARING') {
          throw new BadRequestException('This one is not ready yet');
        }
        await this.prisma.db.order.update({
          where: { id: stop.orderId },
          data: { pickedUpAt: new Date() },
        });
      });

      // READY → ON_THE_WAY. Already on the way (a second parcel from the same counter on a
      // started run) is not an error, so the illegal transition is simply not attempted.
      const current = await TenantContext.runAsTenant(stop.tenantId, () =>
        this.prisma.db.order.findUnique({ where: { id: stop.orderId }, select: { status: true } }),
      );
      if (current?.status === 'READY') {
        await TenantContext.runAsTenant(stop.tenantId, () =>
          this.orders.updateStatus(stop.orderId, 'ON_THE_WAY', `rider:${rider.id}`, 'Collected by the rider'),
        );
      }
    } else {
      await this.checkDeliveryOtp(stop.tenantId, stop.orderId, otp);
      await TenantContext.runAsTenant(stop.tenantId, () =>
        this.orders.updateStatus(stop.orderId, 'DELIVERED', `rider:${rider.id}`, 'Handed over by the rider'),
      );
    }

    await this.prisma.db.tripStop.update({ where: { id: stop.id }, data: { completedAt: new Date() } });
    await this.advanceTrip(stop.tripId);
    return this.tripSheet(token);
  }

  /**
   * The code at the door.
   *
   * A wrong code is counted before it is rejected, because a counter that only advances on
   * the way out is a counter that can be avoided by hanging up. After
   * `DELIVERY_OTP_MAX_ATTEMPTS` the rider is sent to the shop rather than left standing at
   * a door with nothing to try — the shop can still release the delivery from its own
   * panel, and that release is an OrderEvent, so who waived the proof is on the record.
   */
  private async checkDeliveryOtp(tenantId: string, orderId: string, given?: string) {
    await TenantContext.runAsTenant(tenantId, async () => {
      const [shop, order] = await Promise.all([
        this.prisma.db.tenant.findUnique({
          where: { id: tenantId },
          select: { deliveryOtpRequired: true, phone: true },
        }),
        this.prisma.db.order.findUnique({
          where: { id: orderId },
          select: { deliveryOtp: true, deliveryOtpAttempts: true },
        }),
      ]);
      if (!shop?.deliveryOtpRequired) return;
      if (!order) throw new NotFoundException('Order not found');
      // No code was ever issued (the order reached the road before this was switched on).
      // Demanding one the customer never received would strand a real delivery.
      if (!order.deliveryOtp) return;

      if (order.deliveryOtpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS) {
        throw new BadRequestException(
          shop.phone
            ? `Too many wrong codes. Call the shop on ${shop.phone}.`
            : 'Too many wrong codes. Call the shop.',
        );
      }
      if (!given) throw new BadRequestException('Ask the customer for their delivery code');

      if (!deliveryOtpMatches(order.deliveryOtp, given)) {
        const attempts = order.deliveryOtpAttempts + 1;
        await this.prisma.db.order.update({
          where: { id: orderId },
          data: { deliveryOtpAttempts: attempts },
        });
        const left = DELIVERY_OTP_MAX_ATTEMPTS - attempts;
        throw new BadRequestException(
          left > 0 ? `That code is wrong — ${left} more ${left === 1 ? 'try' : 'tries'}` : 'Too many wrong codes. Call the shop.',
        );
      }
    });
  }

  /**
   * A delivery that did not happen.
   *
   * Recorded with a reason and moved to the **end** of the run rather than closed: in a
   * village the answer to "nobody home" is usually "come back after the others", and a
   * failed knock at three o'clock is not the same as a parcel going back on the shelf.
   * Taking it back is a separate, deliberate act — `returnStop`.
   */
  async failStop(token: string, stopId: string, reason: AttemptFailReason, note?: string) {
    const rider = await this.riderByToken(token);
    const stop = await this.stopOnMyRun(rider.id, stopId);
    if (stop.kind !== 'DROP') throw new BadRequestException('Only a delivery can fail this way');
    if (stop.completedAt) throw new BadRequestException('That stop is already done');

    await this.prisma.db.deliveryAttempt.create({
      data: {
        orderId: stop.orderId,
        riderId: rider.id,
        reason,
        note: note?.trim() || null,
        // Where the rider says they were. An attempt filed from the shop's own courtyard
        // is worth being able to recognise later.
        lat: rider.lat,
        lng: rider.lng,
      },
    });

    const last = await this.prisma.db.tripStop.findFirst({
      where: { tripId: stop.tripId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    await this.prisma.db.tripStop.update({
      where: { id: stop.id },
      data: { seq: (last?.seq ?? stop.seq) + 1 },
    });

    await this.advanceTrip(stop.tripId);
    return this.tripSheet(token);
  }

  /** Taking it back to the shop. Ends the delivery; whether money returns is the shop's call. */
  async returnStop(token: string, stopId: string) {
    const rider = await this.riderByToken(token);
    const stop = await this.stopOnMyRun(rider.id, stopId);
    if (stop.kind !== 'DROP') throw new BadRequestException('Only a delivery can be returned');
    if (stop.completedAt) throw new BadRequestException('That stop is already done');

    await TenantContext.runAsTenant(stop.tenantId, () =>
      this.orders.updateStatus(
        stop.orderId,
        'RETURNED',
        `rider:${rider.id}`,
        'Brought back to the shop undelivered',
      ),
    );

    await this.prisma.db.tripStop.update({ where: { id: stop.id }, data: { completedAt: new Date() } });
    // The pickup half is done too — there is nothing left to collect for this order.
    await this.prisma.db.tripStop.updateMany({
      where: { tripId: stop.tripId, orderId: stop.orderId, completedAt: null },
      data: { completedAt: new Date() },
    });
    await this.advanceTrip(stop.tripId);
    return this.tripSheet(token);
  }

  /**
   * The shop letting a delivery through without the code.
   *
   * The rider is at the door, the customer has lost the text, and somebody has to be able
   * to say "give it to them". Clearing the attempt counter rather than deleting the code
   * keeps the release **on the record** — an OrderEvent with the vendor's user id on it —
   * so a shop that waives proof for every order can be seen doing it.
   */
  async releaseDeliveryProof(tenantId: string, orderId: string, actor: string) {
    return TenantContext.runAsTenant(tenantId, async () => {
      const order = await this.prisma.db.order.findUnique({
        where: { id: orderId },
        select: { id: true, status: true },
      });
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'ON_THE_WAY') {
        throw new BadRequestException('Only an order on the road needs its code released');
      }

      await this.prisma.db.order.update({
        where: { id: orderId },
        data: { deliveryOtp: null, deliveryOtpAttempts: 0 },
      });
      await this.prisma.db.orderEvent.create({
        data: {
          orderId,
          status: 'ON_THE_WAY',
          actor,
          note: 'Delivery code waived by the shop',
        },
      });
      return { ok: true };
    });
  }

  /** A stop, confirmed to be on this rider's own run. Ids arrive from a phone. */
  private async stopOnMyRun(riderId: string, stopId: string) {
    const stop = await this.prisma.db.tripStop.findUnique({
      where: { id: stopId },
      select: {
        id: true, seq: true, kind: true, orderId: true, tenantId: true, completedAt: true, tripId: true,
        trip: { select: { riderId: true, status: true } },
      },
    });
    if (!stop || stop.trip.riderId !== riderId) throw new NotFoundException('That stop is not on your run');
    return stop;
  }

  private seqOf(stopId: string): Promise<number> {
    return this.prisma.db.tripStop
      .findUnique({ where: { id: stopId }, select: { seq: true } })
      .then((s) => s?.seq ?? 0);
  }

  private openTrip(riderId: string) {
    return this.prisma.db.trip.findFirst({
      where: { riderId, status: { in: ['PLANNED', 'ACTIVE'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, activeSeq: true, startedAt: true },
    });
  }

  /**
   * The rider's run, in order, with the next stop marked.
   *
   * A pickup carries the shop; a drop carries the address and the cash. The rider needs
   * both kinds on one list — the mistake a multi-shop run invites is arriving at the right
   * village having forgotten a counter.
   */
  async tripSheet(token: string) {
    const rider = await this.riderByToken(token);
    const trip = await this.openTrip(rider.id);
    if (!trip) return { trip: null, stops: [] };

    const stops = await this.prisma.db.tripStop.findMany({
      where: { tripId: trip.id },
      orderBy: { seq: 'asc' },
      select: { id: true, seq: true, kind: true, orderId: true, tenantId: true, completedAt: true },
    });

    const detailed: TripStopView[] = [];
    for (const stop of stops) {
      const { tenantId } = stop;
      const detail = await TenantContext.runAsTenant(tenantId, async () => {
        const [order, shop] = await Promise.all([
          this.prisma.db.order.findUnique({
            where: { id: stop.orderId },
            select: {
              code: true, status: true, dueOnDelivery: true, customerPhone: true,
              deliveryAddress: true, pickedUpAt: true,
            },
          }),
          this.prisma.db.tenant.findUnique({
            where: { id: tenantId },
            select: { name: true, address: true, phone: true },
          }),
        ]);
        return { order, shop };
      });
      if (!detail.order) continue;

      detailed.push({
        id: stop.id,
        seq: stop.seq,
        kind: stop.kind,
        done: Boolean(stop.completedAt),
        active: stop.seq === trip.activeSeq && !stop.completedAt,
        code: detail.order.code,
        status: detail.order.status,
        store: detail.shop?.name ?? '',
        // A pickup shows the shop's own address and phone; a drop shows the customer's.
        // Same card, different halves of the same journey.
        address: stop.kind === 'PICKUP' ? detail.shop?.address ?? '' : null,
        phone: stop.kind === 'PICKUP' ? detail.shop?.phone ?? '' : detail.order.customerPhone,
        deliveryAddress: stop.kind === 'DROP' ? detail.order.deliveryAddress : null,
        dueOnDelivery: stop.kind === 'DROP' ? detail.order.dueOnDelivery : 0,
      });
    }

    return {
      trip: {
        id: trip.id,
        status: trip.status,
        remaining: detailed.filter((s) => !s.done).length,
      },
      stops: detailed,
    };
  }

  /**
   * Which of the rider's shops this order belongs to — and a refusal if it is none of them.
   *
   * Every write a rider makes goes through here first. An order id arrives from a phone,
   * and without this check a rider could name any order in the database and take it,
   * including one from a shop that has never heard of them.
   */
  private async tenantForOffer(riderId: string, orderId: string): Promise<string> {
    const shopIds = await this.approvedShopIds(riderId);

    for (const tenantId of shopIds) {
      const found = await TenantContext.runAsTenant(tenantId, () =>
        this.prisma.db.order.findUnique({ where: { id: orderId }, select: { id: true } }),
      );
      if (found) return tenantId;
    }
    throw new NotFoundException('That delivery is not available to you');
  }

  /** Shops waiting on this rider to say yes. */
  private pendingInvites(riderId: string) {
    return this.prisma.db.riderShop
      .findMany({
        where: { riderId, approved: false },
        orderBy: { createdAt: 'asc' },
        select: { tenantId: true, tenant: { select: { name: true } } },
      })
      .then((rows) => rows.map((r) => ({ tenantId: r.tenantId, store: r.tenant.name })));
  }

  /**
   * The rider answering an invitation.
   *
   * This is the consent step that lets a token be shared safely across shops, and it needs
   * no login precisely because the rider is already holding the only thing that proves who
   * they are. Declining deletes the link rather than remembering a refusal — a shop asking
   * again next month is a normal thing to happen, not an attack to be blocked.
   */
  async respondToInvite(token: string, tenantId: string, accept: boolean) {
    const rider = await this.riderByToken(token);

    const link = await this.prisma.db.riderShop.findUnique({
      where: { riderId_tenantId: { riderId: rider.id, tenantId } },
      select: { approved: true },
    });
    if (!link) throw new NotFoundException('That invitation is no longer there');
    if (link.approved) return { ok: true, approved: true };

    if (!accept) {
      await this.prisma.db.riderShop.delete({
        where: { riderId_tenantId: { riderId: rider.id, tenantId } },
      });
      return { ok: true, approved: false };
    }

    await this.prisma.db.riderShop.update({
      where: { riderId_tenantId: { riderId: rider.id, tenantId } },
      data: { approved: true, approvedAt: new Date() },
    });
    return { ok: true, approved: true };
  }

  /**
   * A rider's phone reporting where it is.
   *
   * Authorised by the run-sheet token, so a position can only be filed against the rider
   * it belongs to. Two things are thrown away here rather than downstream, because once a
   * bad fix is stored it is indistinguishable from a good one:
   *
   *   - a fix too vague to be a location (a wifi lookup indoors can be kilometres out);
   *   - a fix from a rider with nothing on the road, which is a phone left reporting
   *     after the shift and nobody's business.
   *
   * The write is a plain overwrite: we keep where the rider IS, never where they have
   * been. A trail of a named worker's week is a different product with different
   * obligations, and not one anybody asked for.
   */
  async reportRiderLocation(
    input: { token: string; lat: number; lng: number; accuracy?: number },
  ): Promise<RiderLocationResult> {
    const rider = await this.prisma.db.rider.findUnique({
      where: { token: input.token },
      select: { id: true, isActive: true },
    });
    if (!rider || !rider.isActive) throw new NotFoundException('This delivery link is no longer valid');

    if (input.accuracy !== undefined && input.accuracy > RIDER_FIX_MAX_ACCURACY_M) {
      // Accepted, not stored. The rider's phone should not have to understand our rules,
      // and an error here would make their app look broken while they are driving.
      return { accepted: false, reason: 'accuracy', orders: 0 };
    }

    const now = new Date();
    await this.prisma.db.rider.update({
      where: { id: rider.id },
      data: { lat: input.lat, lng: input.lng, locationAt: now },
    });

    // Only orders actually on the road, and only at shops this rider is cleared for. This
    // is both the push list and the answer to "is anyone entitled to see this fix at all",
    // so the approved-shop filter is doing security work, not tidiness.
    const shopIds = await this.approvedShopIds(rider.id);
    const perShop = await Promise.all(
      shopIds.map((tenantId) =>
        TenantContext.runAsTenant(tenantId, () =>
          this.prisma.db.order.findMany({
            where: { riderId: rider.id, status: 'ON_THE_WAY' },
            select: { code: true, customerPhone: true },
          }),
        ),
      ),
    );
    const live = perShop.flat();

    return { accepted: true, at: now.toISOString(), orders: live.length, live };
  }
}

/**
 * Discriminated so the caller cannot read `live` off a rejected fix — the push loop and
 * the rejection path are different shapes, and the compiler should say so.
 */
export type RiderLocationResult =
  | { accepted: false; reason: 'accuracy'; orders: 0 }
  | { accepted: true; at: string; orders: number; live: { code: string; customerPhone: string }[] };

/** One line on the rider's run sheet — a counter to collect from, or a door to knock on. */
export interface TripStopView {
  id: string;
  seq: number;
  kind: StopKind;
  done: boolean;
  /** The one the rider is travelling to right now. */
  active: boolean;
  code: string;
  status: string;
  store: string;
  /** The shop's address on a pickup; a drop carries `deliveryAddress` instead. */
  address: string | null;
  phone: string;
  deliveryAddress: unknown;
  dueOnDelivery: number;
}

/** The rider's own last position, when they have shared one. Used to start the route. */
function riderPoint(rider: { lat: number | null; lng: number | null }): GeoPoint | null {
  return rider.lat != null && rider.lng != null ? { lat: rider.lat, lng: rider.lng } : null;
}

/**
 * What we can tell the matcher about where an order is going.
 *
 * `deliveryAddress` is free-form JSON written by a checkout that has changed shape more
 * than once, so every field here is treated as absent until proven otherwise. A `lat`
 * without an `lng` is not half a pin, it is no pin — and passing one through as a number
 * would put a delivery on the equator.
 */
function addressTarget(address: unknown): DeliveryTarget {
  const a = (address ?? {}) as Record<string, unknown>;
  const lat = typeof a.lat === 'number' ? a.lat : null;
  const lng = typeof a.lng === 'number' ? a.lng : null;
  return {
    point: lat !== null && lng !== null ? { lat, lng } : null,
    area: typeof a.area === 'string' ? a.area : null,
  };
}

/* ─────────────────────────────────────────────────────────── helpers ─── */

/** Wall-clock day and minute-of-day in Asia/Dhaka. */
function dhakaNow(): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    parts.find((p) => p.type === 'weekday')!.value,
  );
  const hour = Number(parts.find((p) => p.type === 'hour')!.value);
  const minute = Number(parts.find((p) => p.type === 'minute')!.value);
  return { day, minutes: hour * 60 + minute };
}

/**
 * Is the kitchen open right now?
 *
 * Handles the case that matters most in this market: a shift that crosses midnight.
 * "18:00–02:00" on Friday must still be open at 1am on Saturday, which a naive
 * open <= now <= close comparison gets wrong every single night.
 */
export function isOpenAt(hours: OpeningHour[], day: number, minutes: number): boolean {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };

  for (const slot of hours) {
    const open = toMinutes(slot.open);
    const close = toMinutes(slot.close);

    if (close > open) {
      if (slot.day === day && minutes >= open && minutes < close) return true;
    } else {
      // Crosses midnight: the evening part belongs to `day`, the small hours to the next.
      if (slot.day === day && minutes >= open) return true;
      if ((slot.day + 1) % 7 === day && minutes < close) return true;
    }
  }
  return false;
}

/** Midnight tonight in Dhaka, expressed as an instant. */
function nextDhakaMidnight(): Date {
  const now = new Date();
  const { minutes } = dhakaNow();
  const untilMidnight = (24 * 60 - minutes) * 60 * 1000;
  return new Date(now.getTime() + untilMidnight);
}
