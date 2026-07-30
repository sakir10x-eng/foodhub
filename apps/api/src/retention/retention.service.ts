import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { NotificationsService } from '../infra/notifications.service';

/**
 * The three things that bring a customer back: a reminder about the basket they left, a
 * standing order that removes the decision entirely, and a scheduled order that lets them
 * buy now for later.
 *
 * All three are cheap to run and expensive to get wrong — a reminder that fires twice, or
 * a standing order that fires while the kitchen is closed, costs more goodwill than the
 * order is worth. Hence the once-only guards throughout.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /* ──────────────────────────────────────────────── abandoned carts */

  /**
   * Remember a basket against a phone number.
   *
   * Called once the customer has typed a number at checkout — before that there is nobody
   * to remind, and storing anonymous baskets would be collecting data we cannot use.
   */
  async rememberCart(tenantId: string, phone: string, items: any[], subtotal: number) {
    if (!phone || items.length === 0) return { ok: false };

    await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.abandonedCart.upsert({
        where: { tenantId_phone: { tenantId, phone } },
        // A returning customer's newer basket replaces the older one, and the reminder
        // clock restarts — otherwise they get chased about a cart they already changed.
        update: { items, subtotal, remindedAt: null, recoveredAt: null },
        create: { tenantId, phone, items, subtotal },
      }),
    );
    return { ok: true };
  }

  /** Called when an order is placed, so a recovered basket stops being chased. */
  async markRecovered(tenantId: string, phone: string) {
    await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.abandonedCart.updateMany({
        where: { tenantId, phone, recoveredAt: null },
        data: { recoveredAt: new Date() },
      }),
    );
  }

  /**
   * One reminder, thirty minutes after the basket went cold.
   *
   * Thirty minutes is the shape of the problem: sooner and you interrupt someone who is
   * still deciding, much later and they have eaten. One message only — a second reminder
   * for a ৳400 basket is how a brand becomes something people block.
   */
  @Cron('*/10 * * * *')
  async sendCartReminders() {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const carts = await TenantContext.runAsPlatform('cart recovery sweeps every vendor', () =>
      this.prisma.db.abandonedCart.findMany({
        where: {
          remindedAt: null,
          recoveredAt: null,
          updatedAt: { lt: cutoff, gt: stale },
        },
        include: { tenant: { select: { name: true, slug: true, isOpen: true } } },
        take: 200,
      }),
    );

    for (const cart of carts) {
      // Sending "come back and order" while the kitchen is shut produces a tap, a closed
      // store, and a customer who does not tap next time.
      if (!cart.tenant.isOpen) continue;

      const taka = (cart.subtotal / 100).toFixed(0);
      await this.notifications.send({
        channel: 'sms',
        to: cart.phone,
        message: `Your ${cart.tenant.name} basket (Tk${taka}) is still waiting. Finish your order any time.`,
      });
      await TenantContext.runAsTenant(cart.tenantId, () =>
        this.prisma.db.abandonedCart.update({
          where: { id: cart.id },
          data: { remindedAt: new Date() },
        }),
      );
    }

    if (carts.length) this.logger.log(`Cart recovery: reminded ${carts.length}`);
  }

  /* ─────────────────────────────────────────────── scheduled orders */

  /**
   * Validate a requested delivery time against what the vendor allows.
   *
   * Returns the parsed instant, or throws with the reason. A time in the past, or one
   * further out than the vendor is willing to commit to, is a promise we cannot keep.
   */
  validateScheduledFor(
    raw: string | undefined,
    tenant: { schedulingEnabled: boolean; schedulingMaxDays: number; prepMinutes: number },
  ): Date | null {
    if (!raw) return null;
    if (!tenant.schedulingEnabled) {
      throw new BadRequestException('This store does not take orders for later yet');
    }

    const when = new Date(raw);
    if (Number.isNaN(when.getTime())) throw new BadRequestException('That delivery time is not valid');

    // The kitchen still needs its prep time, so "in five minutes" is not a schedule.
    const earliest = Date.now() + tenant.prepMinutes * 60 * 1000;
    if (when.getTime() < earliest) {
      throw new BadRequestException(`The earliest time available is about ${tenant.prepMinutes} minutes from now`);
    }

    const latest = Date.now() + tenant.schedulingMaxDays * 24 * 60 * 60 * 1000;
    if (when.getTime() > latest) {
      throw new BadRequestException(`This store takes orders up to ${tenant.schedulingMaxDays} days ahead`);
    }
    return when;
  }

  /**
   * How much the reminders actually recovered.
   *
   * Shown to the vendor because "we sent 40 reminders" is not a result — "৳6,200 came
   * back" is, and it is also how they decide whether the feature earns its noise.
   */
  async cartStats(tenantId: string) {
    const [abandoned, recovered] = await Promise.all([
      this.prisma.db.abandonedCart.aggregate({
        where: { remindedAt: { not: null }, recoveredAt: null },
        _count: { _all: true },
        _sum: { subtotal: true },
      }),
      this.prisma.db.abandonedCart.aggregate({
        where: { recoveredAt: { not: null } },
        _count: { _all: true },
        _sum: { subtotal: true },
      }),
    ]);
    return {
      reminded: abandoned._count._all,
      stillOpen: abandoned._sum.subtotal ?? 0,
      recovered: recovered._count._all,
      recoveredValue: recovered._sum.subtotal ?? 0,
    };
  }

  /* ──────────────────────────────────────────── recurring orders */

  async createRecurring(
    tenantId: string,
    input: { phone: string; items: any[]; address: any; daysOfWeek: number[]; timeOfDay: string },
  ) {
    const created = await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.subscription_Order.create({
        data: {
          tenantId,
          phone: input.phone,
          items: input.items,
          address: input.address,
          daysOfWeek: input.daysOfWeek,
          timeOfDay: input.timeOfDay,
        },
      }),
    );
    return { id: created.id, ok: true };
  }


  /**
   * Fire standing orders whose time has come.
   *
   * Runs every fifteen minutes and matches on the wall clock in Dhaka, because "8am chai"
   * means 8am where the customer is — not 8am UTC, and not 8am wherever the server sits.
   * `lastRunAt` guards against a restart replaying the window.
   */
  @Cron('*/15 * * * *')
  async runRecurringOrders() {
    const now = new Date();
    const dhaka = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hour12: false,
    }).formatToParts(now);

    const hh = dhaka.find((p) => p.type === 'hour')!.value;
    const mm = dhaka.find((p) => p.type === 'minute')!.value;
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
      dhaka.find((p) => p.type === 'weekday')!.value,
    );
    const nowMinutes = Number(hh) * 60 + Number(mm);

    const due = await TenantContext.runAsPlatform('recurring orders sweep every vendor', () =>
      this.prisma.db.subscription_Order.findMany({
        where: {
          isActive: true,
          OR: [{ lastRunAt: null }, { lastRunAt: { lt: new Date(now.getTime() - 12 * 60 * 60 * 1000) } }],
        },
        include: { tenant: { select: { isOpen: true, name: true } } },
        take: 200,
      }),
    );

    let fired = 0;
    for (const sub of due) {
      if (sub.daysOfWeek.length > 0 && !sub.daysOfWeek.includes(weekday)) continue;

      const [h, m] = sub.timeOfDay.split(':').map(Number);
      const target = h * 60 + m;
      // A 15-minute window either side, so a cron that runs a minute late still fires.
      if (Math.abs(nowMinutes - target) > 15) continue;
      if (!sub.tenant.isOpen) continue;

      // Marked before the notification, not after: a failure that leaves lastRunAt unset
      // would re-fire the same standing order on the next tick.
      await TenantContext.runAsTenant(sub.tenantId, () =>
        this.prisma.db.subscription_Order.update({
          where: { id: sub.id },
          data: { lastRunAt: now },
        }),
      );

      /*
       * A prompt, not an automatic order.
       *
       * Placing it outright would mean a kitchen cooking food nobody confirmed that
       * morning — and with cash on delivery there is no card to charge if the customer
       * has gone out. One tap to confirm keeps all the convenience and none of the waste.
       */
      await this.notifications.send({
        channel: 'sms',
        to: sub.phone,
        message: `Your usual from ${sub.tenant.name} is ready to order. Tap to confirm.`,
      });
      fired++;
    }

    if (fired) this.logger.log(`Recurring orders: prompted ${fired}`);
  }
}
