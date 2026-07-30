import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * WhatsApp via Meta's Cloud API — the channel Bangladeshi customers actually read.
 *
 * Two rules that shape this file:
 *
 *  1. Outside a 24-hour window opened by the customer messaging first, Meta only delivers
 *     pre-approved TEMPLATE messages. An order confirmation is almost always outside that
 *     window, so `sendTemplate` is the real entry point and free-text `send` is only for
 *     replying inside a live conversation (which is what the AI bot does).
 *  2. Unlike SMS, Bengali costs nothing extra here — so this is where the Bangla copy goes.
 */
@Injectable()
export class WhatsAppTransport {
  private readonly logger = new Logger(WhatsAppTransport.name);

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    const cfg = this.config.get<{ token: string; phoneNumberId: string }>('notifications.whatsapp');
    return Boolean(cfg?.token && cfg?.phoneNumberId);
  }

  /** A pre-approved template. The only thing that reaches a customer who has not written in. */
  async sendTemplate(to: string, template: string, params: string[]): Promise<void> {
    await this.post(to, {
      type: 'template',
      template: {
        name: template,
        language: { code: 'bn' },
        components: params.length
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : undefined,
      },
    });
  }

  /** Free text. Only valid inside the 24-hour service window. */
  async send(to: string, message: string): Promise<void> {
    await this.post(to, { type: 'text', text: { body: message, preview_url: false } });
  }

  private async post(to: string, payload: Record<string, unknown>) {
    const cfg = this.config.get<{ token: string; phoneNumberId: string }>('notifications.whatsapp');
    if (!cfg?.token || !cfg?.phoneNumberId) throw new Error('WhatsApp is not configured');

    const res = await fetch(`https://graph.facebook.com/v21.0/${cfg.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: normalise(to), ...payload }),
    });

    if (!res.ok) {
      const detail: any = await res.json().catch(() => ({}));
      throw new Error(`WhatsApp rejected the message: ${detail?.error?.message ?? res.status}`);
    }
  }
}

/** Meta wants a bare international number, no plus. */
function normalise(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `88${digits}`;
  return `880${digits}`;
}
