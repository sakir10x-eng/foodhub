import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Email via Mailgun's HTTP API rather than SMTP: most hosts block outbound 25/465/587,
 * and an HTTPS POST works from inside any container without a mail relay.
 *
 * Email is the least useful channel for a Bangladeshi food customer — it is here for
 * vendor-facing mail (invoices, weekly summaries), not order updates.
 */
@Injectable()
export class EmailTransport {
  constructor(private readonly config: ConfigService) {}

  get configured(): boolean {
    const cfg = this.config.get<{ apiKey: string; domain: string }>('notifications.email');
    return Boolean(cfg?.apiKey && cfg?.domain);
  }

  async send(to: string, subject: string, html: string): Promise<void> {
    const cfg = this.config.get<{ apiKey: string; domain: string; from: string }>('notifications.email');
    if (!cfg?.apiKey || !cfg?.domain) throw new Error('Email is not configured');

    const body = new URLSearchParams({
      from: cfg.from || `FoodHub <noreply@${cfg.domain}>`,
      to,
      subject,
      html,
    });

    const res = await fetch(`https://api.mailgun.net/v3/${cfg.domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${cfg.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!res.ok) throw new Error(`Mailgun rejected the message: ${res.status}`);
  }
}
