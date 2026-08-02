import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { RIDER_FIX_MAX_ACCURACY_M } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { CacheService } from '../infra/cache.service';

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
   * A vendor's own riders.
   *
   * `tenantId` is written out even though the guard now adds it, because this select
   * returns `token` — and a token is a working delivery link into whichever shop's
   * customer addresses, phone numbers and cash amounts the rider is carrying. A filter
   * that only exists in one layer is one refactor away from not existing.
   */
  listRiders(tenantId: string) {
    return this.prisma.db.rider.findMany({
      where: { tenantId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, phone: true, token: true },
    });
  }

  async addRider(tenantId: string, name: string, phone: string) {
    return this.prisma.db.rider.create({
      // The token is what a rider's own view is addressed by, so it is random rather than
      // derived — a guessable one would expose every customer's address to anyone.
      data: { tenantId, name, phone, token: randomBytes(16).toString('base64url') },
      select: { id: true, name: true, phone: true, token: true },
    });
  }

  async removeRider(tenantId: string, id: string) {
    // Deactivated, never deleted: past orders point at this rider, and a delivery with no
    // record of who carried it is exactly what you need on the day something goes wrong.
    const removed = await this.prisma.db.rider.updateMany({
      where: { id, tenantId },
      data: { isActive: false },
    });
    // Somebody else's rider is not "already gone", it is not ours to touch — and saying so
    // is also how the tenant-isolation test can tell a refusal from a no-op.
    if (removed.count === 0) throw new NotFoundException('Rider not found');
    return { ok: true };
  }

  async assignRider(orderId: string, riderId: string | null) {
    const order = await this.prisma.db.order.findUnique({ where: { id: orderId }, select: { id: true } });
    if (!order) throw new NotFoundException('Order not found');

    // The order is guarded, but `riderId` arrives from the client and nothing here had
    // ever checked it: a vendor could hand their delivery to another shop's rider, who
    // would then see this shop's customer on their run sheet. Resolving the rider through
    // the guarded client is the check — a foreign id simply finds no row.
    if (riderId) {
      const rider = await this.prisma.db.rider.findUnique({
        where: { id: riderId },
        select: { id: true, isActive: true },
      });
      if (!rider || !rider.isActive) throw new NotFoundException('Rider not found');
    }

    await this.prisma.db.order.update({ where: { id: orderId }, data: { riderId } });
    return { ok: true };
  }

  /** What one rider is carrying. Addressed by their token, not by a login. */
  async riderQueue(token: string) {
    const rider = await TenantContext.runAsPlatform('a rider view is addressed by its own token', () =>
      this.prisma.db.rider.findUnique({
        where: { token },
        select: { id: true, name: true, tenantId: true, isActive: true, tenant: { select: { name: true } } },
      }),
    );
    if (!rider || !rider.isActive) throw new NotFoundException('This delivery link is no longer valid');

    const orders = await TenantContext.runAsTenant(rider.tenantId, () =>
      this.prisma.db.order.findMany({
        where: { riderId: rider.id, status: { in: ['READY', 'ON_THE_WAY'] } },
        orderBy: { placedAt: 'asc' },
        select: {
          id: true, code: true, status: true, total: true, dueOnDelivery: true,
          deliveryAddress: true, customerPhone: true, placedAt: true,
        },
      }),
    );

    return { rider: { name: rider.name, store: rider.tenant.name }, orders };
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
    const rider = await TenantContext.runAsPlatform('a rider reports position against its own token', () =>
      this.prisma.db.rider.findUnique({
        where: { token: input.token },
        select: { id: true, tenantId: true, isActive: true },
      }),
    );
    if (!rider || !rider.isActive) throw new NotFoundException('This delivery link is no longer valid');

    if (input.accuracy !== undefined && input.accuracy > RIDER_FIX_MAX_ACCURACY_M) {
      // Accepted, not stored. The rider's phone should not have to understand our rules,
      // and an error here would make their app look broken while they are driving.
      return { accepted: false, reason: 'accuracy', orders: 0 };
    }

    const now = new Date();
    const live = await TenantContext.runAsTenant(rider.tenantId, async () => {
      await this.prisma.db.rider.update({
        where: { id: rider.id },
        data: { lat: input.lat, lng: input.lng, locationAt: now },
      });
      // Only orders actually on the road: this is both the push list and the answer to
      // "is anyone entitled to see this fix at all".
      return this.prisma.db.order.findMany({
        where: { riderId: rider.id, status: 'ON_THE_WAY' },
        select: { code: true, customerPhone: true },
      });
    });

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
