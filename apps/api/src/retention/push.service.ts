import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification lands. */
  url?: string;
  /** Collapses an older notification about the same order rather than stacking. */
  tag?: string;
}

/**
 * Web push — the only retention channel with no per-message cost.
 *
 * That single property is why it is worth the VAPID setup: an SMS costs money every time,
 * so nobody sends "your rider is 5 minutes away". Push can, and it is exactly the message
 * that stops a customer phoning the restaurant.
 *
 * Dead subscriptions are pruned rather than retried. A browser that has been uninstalled
 * returns 404/410 forever, and a queue that keeps retrying them slowly fills with garbage.
 */
@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private ready = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    const vapid = this.config.get<{ publicKey: string; privateKey: string; subject: string }>('push.vapid');
    if (!vapid?.publicKey || !vapid?.privateKey) {
      this.logger.log('Push: no VAPID keys configured (generate with `npx web-push generate-vapid-keys`)');
      return;
    }
    webpush.setVapidDetails(vapid.subject || 'mailto:support@foodhub.example', vapid.publicKey, vapid.privateKey);
    this.ready = true;
    this.logger.log('Push: ready');
  }

  get publicKey(): string {
    return this.config.get<string>('push.vapid.publicKey') ?? '';
  }

  get configured(): boolean {
    return this.ready;
  }

  async subscribe(input: {
    tenantId: string | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    phone?: string;
    userId?: string;
  }) {
    await TenantContext.runAsPlatform('a push subscription may arrive before any order', () =>
      this.prisma.unsafeRaw.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        // Re-subscribing refreshes the keys and clears any earlier failure — a browser
        // that comes back after a reinstall should start receiving again.
        update: {
          p256dh: input.p256dh,
          auth: input.auth,
          phone: input.phone ?? undefined,
          userId: input.userId ?? undefined,
          tenantId: input.tenantId,
          lastSeenAt: new Date(),
          failedAt: null,
        },
        create: {
          tenantId: input.tenantId,
          endpoint: input.endpoint,
          p256dh: input.p256dh,
          auth: input.auth,
          phone: input.phone ?? null,
          userId: input.userId ?? null,
        },
      }),
    );
    return { ok: true };
  }

  async unsubscribe(endpoint: string) {
    await TenantContext.runAsPlatform('unsubscribe is keyed by a globally unique endpoint', () =>
      this.prisma.unsafeRaw.pushSubscription.deleteMany({ where: { endpoint } }),
    );
    return { ok: true };
  }

  /** Every live device belonging to one phone number. */
  async sendToPhone(phone: string, payload: PushPayload) {
    if (!this.ready) return 0;
    const subs = await TenantContext.runAsPlatform('push targets a customer across vendors', () =>
      this.prisma.unsafeRaw.pushSubscription.findMany({
        where: { phone, failedAt: null },
        take: 10,
      }),
    );
    return this.fanOut(subs, payload);
  }

  private async fanOut(subs: any[], payload: PushPayload): Promise<number> {
    let sent = 0;
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: 900 }, // fifteen minutes: an order update is worthless once it is stale
          );
          sent++;
        } catch (err: any) {
          // 404/410 mean the browser is gone for good. Anything else may be transient.
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            await TenantContext.runAsPlatform('pruning a dead push endpoint', () =>
              this.prisma.unsafeRaw.pushSubscription.updateMany({
                where: { endpoint: sub.endpoint },
                data: { failedAt: new Date() },
              }),
            );
          } else {
            this.logger.warn(`Push failed (${err?.statusCode ?? 'unknown'}): ${err?.message}`);
          }
        }
      }),
    );
    return sent;
  }
}
