import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * SMS via sms.net.bd — the provider most Bangladeshi businesses already have an account
 * with, and the one whose masking/DLT paperwork is simplest here.
 *
 * The one thing worth knowing about SMS in Bangladesh: a message containing ANY Bengali
 * character is sent as UCS-2, which fits 70 characters per part instead of 160. A two-line
 * Bangla confirmation is routinely billed as three SMS. So order texts are written in
 * English/Banglish and stay inside one part — Bangla goes out over WhatsApp, where the
 * character set costs nothing. `partsFor()` exists so that stays measurable rather than
 * a comment nobody checks.
 */
@Injectable()
export class SmsTransport {
  private readonly logger = new Logger(SmsTransport.name);

  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    return Boolean(this.config.get<string>('notifications.sms.apiKey'));
  }

  /**
   * Send one message, optionally through a vendor's own account.
   *
   * `from` is how a Mode A storefront's texts carry the restaurant's masked sender ID
   * rather than ours. Falls back to the platform account when a vendor has not connected
   * one, so nothing stops working while they get their masking approved.
   */
  async send(to: string, message: string, from?: { apiKey: string; senderId?: string }): Promise<void> {
    const apiKey = from?.apiKey || this.config.get<string>('notifications.sms.apiKey');
    if (!apiKey) throw new Error('SMS provider is not configured');
    const senderId = from?.apiKey ? from.senderId : this.config.get<string>('notifications.sms.senderId');

    const parts = partsFor(message);
    if (parts > 1) {
      // Not fatal, but every extra part is real money at BD volumes.
      this.logger.warn(`SMS to ${mask(to)} costs ${parts} parts (${message.length} chars)`);
    }

    const body = new URLSearchParams({
      api_key: apiKey,
      msg: message,
      to: normalise(to),
      ...(senderId ? { sender_id: senderId } : {}),
    });

    const res = await fetch('https://api.sms.net.bd/sendsms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json: any = await res.json().catch(() => ({}));

    // The provider answers HTTP 200 with an error code in the body, so the status line
    // alone would report every failure as a success.
    if (json?.error !== 0) {
      throw new Error(`sms.net.bd rejected the message: ${json?.msg ?? res.status}`);
    }
  }
}

/** BD numbers go to the provider as 8801XXXXXXXXX. */
function normalise(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('880')) return digits;
  if (digits.startsWith('0')) return `88${digits}`;
  return `880${digits}`;
}

/**
 * How many SMS parts a message will actually be billed as.
 *
 * GSM-7 fits 160 characters in one part and 153 in each part of a longer message; any
 * non-GSM character forces UCS-2, which fits 70 and 67. Bengali is always UCS-2.
 */
export function partsFor(message: string): number {
  const unicode = /[^\x00-\x7F]/.test(message);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return message.length <= single ? 1 : Math.ceil(message.length / multi);
}

function mask(phone: string): string {
  return phone.replace(/\d(?=\d{2})/g, '•');
}
