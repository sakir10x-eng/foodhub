import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderStatus } from '@foodhub/shared';
import { JOBS, QueueService } from './queue.service';
import { SmsTransport, partsFor } from './transports/sms.transport';
import { WhatsAppTransport } from './transports/whatsapp.transport';
import { EmailTransport } from './transports/email.transport';
import { PushService } from '../retention/push.service';
import { TenantService } from '../tenancy/tenant.service';

export type NotifyChannel = 'sms' | 'whatsapp' | 'email';

/** Short enough to survive a lock-screen truncation. */
const PUSH_TITLES: Partial<Record<OrderStatus, string>> = {
  CONFIRMED: 'Order confirmed',
  PREPARING: 'Your food is being cooked',
  READY: 'Ready for pickup',
  ON_THE_WAY: 'On the way',
  DELIVERED: 'Delivered — enjoy!',
  CANCELLED: 'Order cancelled',
};

interface NotifyJob {
  channel: NotifyChannel;
  to: string;
  message: string;
  /** WhatsApp only: the approved template and its ordered parameters. */
  template?: { name: string; params: string[] };
  subject?: string;
  /**
   * Whose account to send from. A Mode A order text should carry the restaurant's own
   * masked sender ID, not ours — the customer ordered from them, not from us.
   */
  tenantId?: string;
}

/**
 * Order notifications.
 *
 * Everything goes through the queue: a gateway that takes four seconds to answer must
 * never add four seconds to a customer's checkout.
 *
 * Channel choice is not a preference, it is economics. A Bangladeshi customer reads
 * WhatsApp far more reliably than SMS, and WhatsApp costs the same whatever the script —
 * so Bangla copy goes there. SMS is the fallback for anyone not on WhatsApp, and its copy
 * is deliberately English and short, because one Bengali character triples the bill (see
 * `partsFor`). Getting this backwards is how a notification budget quietly becomes the
 * second-largest line item.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly queue: QueueService,
    private readonly config: ConfigService,
    private readonly sms: SmsTransport,
    private readonly whatsapp: WhatsAppTransport,
    private readonly email: EmailTransport,
    // Optional: push lives in a feature module, and notifications must keep working in
    // any context where that module is not loaded.
    @Optional() private readonly push?: PushService,
    // Optional for the same reason as push: notifications must work in any context where
    // the tenancy module is not loaded.
    @Optional() private readonly tenants?: TenantService,
  ) {}

  onModuleInit() {
    this.queue.register(JOBS.ORDER_PLACED, (p) => this.onOrderPlaced(p));
    this.queue.register(JOBS.ORDER_STATUS_CHANGED, (p) => this.onStatusChanged(p));
    this.queue.register(JOBS.NOTIFY, (p: NotifyJob) => this.deliver(p));

    const live = [
      this.sms.configured && 'SMS',
      this.whatsapp.configured && 'WhatsApp',
      this.email.configured && 'email',
    ].filter(Boolean);
    this.logger.log(
      live.length ? `Notifications live on: ${live.join(', ')}` : 'Notifications: no transport configured (logging only)',
    );
  }

  private async onOrderPlaced(payload: {
    code: string; phone: string; total: number; tenantId?: string; tenantName?: string;
  }) {
    const taka = (payload.total / 100).toFixed(0);
    await this.notify({
      to: payload.phone,
      tenantId: payload.tenantId,
      // Bangla on WhatsApp, where it is free; English on SMS, where it is not.
      whatsapp: {
        template: { name: 'order_received', params: [payload.code, taka] },
        text: `আপনার অর্ডার ${payload.code} পাওয়া গেছে — ৳${taka}। রেস্টুরেন্ট নিশ্চিত করলেই জানিয়ে দেব।`,
      },
      sms: `Order ${payload.code} received - Tk${taka}. We will confirm shortly.`,
    });
  }

  private async onStatusChanged(payload: {
    code: string; phone: string; status: OrderStatus; tenantId?: string;
  }) {
    /*
     * Push first, and in addition rather than instead.
     *
     * It costs nothing, so it can carry the states that are not worth an SMS — and unlike
     * SMS it opens straight onto the tracking page. If the customer never granted
     * permission this is a no-op and the paid channel below still runs.
     */
    void this.push?.sendToPhone(payload.phone, {
      title: PUSH_TITLES[payload.status] ?? 'Order update',
      body: `Order ${payload.code}`,
      url: `/order/${payload.code}?phone=${encodeURIComponent(payload.phone)}`,
      tag: `order-${payload.code}`,
    });

    const c = payload.code;
    const COPY: Partial<Record<OrderStatus, { bn: string; en: string; template: string }>> = {
      CONFIRMED:  { bn: `অর্ডার ${c} নিশ্চিত হয়েছে, রান্না শুরু হচ্ছে।`, en: `Order ${c} confirmed. Kitchen has started.`, template: 'order_confirmed' },
      READY:      { bn: `অর্ডার ${c} তৈরি।`,                              en: `Order ${c} is ready.`,                     template: 'order_ready' },
      ON_THE_WAY: { bn: `অর্ডার ${c} রওনা দিয়েছে।`,                      en: `Order ${c} is on the way.`,                template: 'order_on_the_way' },
      DELIVERED:  { bn: `অর্ডার ${c} পৌঁছে গেছে। ধন্যবাদ!`,               en: `Order ${c} delivered. Thank you!`,         template: 'order_delivered' },
      CANCELLED:  { bn: `অর্ডার ${c} বাতিল হয়েছে।`,                      en: `Order ${c} was cancelled.`,                template: 'order_cancelled' },
    };

    // PREPARING deliberately sends nothing. A message per transition is how you teach
    // people to ignore your messages, and CONFIRMED already told them the kitchen started.
    const copy = COPY[payload.status];
    if (!copy) return;

    await this.notify({
      to: payload.phone,
      tenantId: payload.tenantId,
      whatsapp: { template: { name: copy.template, params: [c] }, text: copy.bn },
      sms: copy.en,
    });
  }

  /**
   * Send one message on the best channel available.
   *
   * WhatsApp first, SMS as the fallback — not both. Two notifications for one event reads
   * as a broken system and costs twice.
   */
  private async notify(input: {
    to: string;
    tenantId?: string;
    whatsapp: { template: { name: string; params: string[] }; text: string };
    sms: string;
  }) {
    if (this.whatsapp.configured) {
      await this.queue.enqueue(JOBS.NOTIFY, {
        channel: 'whatsapp',
        to: input.to,
        message: input.whatsapp.text,
        template: input.whatsapp.template,
        tenantId: input.tenantId,
      } satisfies NotifyJob);
      return;
    }
    await this.queue.enqueue(JOBS.NOTIFY, {
      channel: 'sms',
      to: input.to,
      message: input.sms,
      tenantId: input.tenantId,
    } satisfies NotifyJob);
  }

  /** Public seam for other modules (marketing, cart recovery, vendor alerts). */
  async send(job: NotifyJob) {
    await this.queue.enqueue(JOBS.NOTIFY, job);
  }

  /**
   * The vendor's own SMS account, if they have connected one.
   *
   * Resolved at send time rather than at enqueue time so a vendor connecting their account
   * takes effect on the very next message, and so a queued job never carries a copy of an
   * API key around with it.
   */
  private async vendorSms(tenantId?: string): Promise<{ apiKey: string; senderId?: string } | undefined> {
    if (!tenantId || !this.tenants) return undefined;
    try {
      const cfg = await this.tenants.readSmsConfig(tenantId);
      if (!cfg?.apiKey || cfg.provider === 'NONE') return undefined;
      return { apiKey: cfg.apiKey, senderId: cfg.senderId };
    } catch {
      // Falling back to the platform account beats not telling the customer anything.
      return undefined;
    }
  }

  private async deliver(job: NotifyJob) {
    const transport = { sms: this.sms, whatsapp: this.whatsapp, email: this.email }[job.channel];

    if (!transport?.configured) {
      // Development has no provider; production without one is a real problem that must
      // be visible, because orders are being placed and nobody is being told.
      const level = this.config.get<string>('env') === 'production' ? 'warn' : 'log';
      this.logger[level](`[${job.channel} -> ${mask(job.to)}] ${job.message}`);
      return;
    }

    try {
      if (job.channel === 'whatsapp') {
        // Outside the 24-hour service window only a template is delivered, and an order
        // update is almost always outside it.
        if (job.template) await this.whatsapp.sendTemplate(job.to, job.template.name, job.template.params);
        else await this.whatsapp.send(job.to, job.message);
      } else if (job.channel === 'email') {
        await this.email.send(job.to, job.subject ?? 'FoodHub', job.message);
      } else {
        await this.sms.send(job.to, job.message, await this.vendorSms(job.tenantId));
      }
    } catch (err) {
      this.logger.error(`${job.channel} to ${mask(job.to)} failed: ${(err as Error).message}`);

      // A failed WhatsApp is worth one SMS retry — the customer still needs to know their
      // food is coming. A failed SMS is not retried on another channel; there isn't one.
      if (job.channel === 'whatsapp' && this.sms.configured) {
        this.logger.log(`Falling back to SMS for ${mask(job.to)}`);
        await this.sms
          .send(job.to, stripToAscii(job.message), await this.vendorSms(job.tenantId))
          .catch((e) => this.logger.error(`SMS fallback also failed: ${(e as Error).message}`));
      }
      throw err; // let the queue's retry policy see it
    }
  }
}

/**
 * A WhatsApp message is Bangla; sending that same string over SMS would triple the cost
 * for a fallback nobody chose. Anything non-ASCII is dropped rather than transliterated —
 * a mangled Banglish auto-transliteration reads worse than plain English.
 */
function stripToAscii(message: string): string {
  const ascii = message.replace(/[^\x00-\x7F]+/g, '').replace(/\s+/g, ' ').trim();
  return ascii.length >= 10 ? ascii : 'You have an update on your FoodHub order.';
}

function mask(to: string): string {
  return to.replace(/[\w.](?=[\w.@]{3})/g, '•');
}

export { partsFor };
