import { BadRequestException, Injectable, Logger } from '@nestjs/common';

export interface BkashCredentials {
  appKey: string;
  appSecret: string;
  username: string;
  password: string;
  sandbox: boolean;
}

export interface BkashCreateResult {
  paymentID: string;
  bkashURL: string;
}

export interface BkashExecuteResult {
  trxID: string;
  paymentID: string;
  /** Poisha. Converted from bKash's decimal-string taka. */
  amount: number;
  status: string;
  raw: Record<string, unknown>;
}

/**
 * bKash Tokenized Checkout.
 *
 * Three properties of this API shape everything below:
 *
 *  1. **The token is rate-limited.** `grant` is not free — bKash throttles merchants who
 *     ask for a token per payment, and a throttled merchant cannot take money at all.
 *     Tokens live ~an hour, so they are cached per credential set with a safety margin.
 *
 *  2. **Create and execute are separate, and only execute takes the money.** A payment
 *     that is created and authorised but never executed is a customer who has been debited
 *     with no order confirmed. Every failure path here leans towards *querying* the real
 *     status rather than assuming failure.
 *
 *  3. **The callback is the customer's browser, not a server webhook.** bKash redirects the
 *     user to `callbackURL` with `paymentID` and `status` in the query string. There is no
 *     signed server-to-server notification to fall back on, which is why the status query
 *     exists and why reconciliation matters.
 */
@Injectable()
export class BkashTransport {
  private readonly logger = new Logger(BkashTransport.name);

  /** keyed by appKey — a platform and a vendor account must never share a token. */
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  private base(sandbox: boolean): string {
    return sandbox
      ? 'https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout'
      : 'https://tokenized.pay.bka.sh/v1.2.0-beta/tokenized/checkout';
  }

  /**
   * A valid id_token, from cache where possible.
   *
   * Refreshed a full five minutes early: a token that expires mid-request produces an
   * "invalid token" on `execute`, which is the one call where a retry is expensive.
   */
  private async token(cfg: BkashCredentials): Promise<string> {
    const cached = this.tokens.get(cfg.appKey);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const res = await fetch(`${this.base(cfg.sandbox)}/token/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        username: cfg.username,
        password: cfg.password,
      },
      body: JSON.stringify({ app_key: cfg.appKey, app_secret: cfg.appSecret }),
    });

    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || !json?.id_token) {
      /*
       * bKash answers HTTP 200 with the real failure in the body, so the status line is
       * almost never the useful part. The vendor sees this message in their panel, so it
       * names the likely cause rather than echoing a number they cannot act on — the
       * overwhelmingly common one is sandbox credentials left on a live merchant, or the
       * reverse.
       */
      const reason = json?.statusMessage || json?.message || `HTTP ${res.status}`;
      throw new BadRequestException(
        `bKash rejected the merchant credentials (${reason}). ` +
          `Check the app key, app secret, username and password, and whether this is a ` +
          `${cfg.sandbox ? 'sandbox' : 'live'} account.`,
      );
    }

    const ttlSeconds = Number(json.expires_in ?? 3600);
    this.tokens.set(cfg.appKey, {
      token: json.id_token,
      expiresAt: Date.now() + Math.max(60, ttlSeconds - 300) * 1000,
    });
    return json.id_token;
  }

  /** Starts a payment and returns the URL to send the customer to. */
  async create(
    cfg: BkashCredentials,
    input: { amount: number; invoice: string; callbackUrl: string; payerReference: string },
  ): Promise<BkashCreateResult> {
    const json = await this.call(cfg, 'create', {
      // '0011' is tokenized checkout without an agreement — the right mode for a one-off
      // order. Agreement modes exist for saved wallets and are a different consent flow.
      mode: '0011',
      payerReference: input.payerReference,
      callbackURL: input.callbackUrl,
      amount: toTaka(input.amount),
      currency: 'BDT',
      intent: 'sale',
      merchantInvoiceNumber: input.invoice,
    });

    if (!json?.paymentID || !json?.bkashURL) {
      throw new BadRequestException(`bKash could not start the payment: ${json?.statusMessage ?? 'unknown error'}`);
    }
    return { paymentID: json.paymentID, bkashURL: json.bkashURL };
  }

  /**
   * Takes the money. The only call that moves anything.
   *
   * A repeat execute of a payment that already completed answers with an error rather than
   * the original result, so that case falls through to a status query — treating it as a
   * failure would abandon an order the customer has genuinely paid for.
   */
  async execute(cfg: BkashCredentials, paymentID: string): Promise<BkashExecuteResult> {
    const json = await this.call(cfg, 'execute', { paymentID });

    if (json?.transactionStatus === 'Completed' && json?.trxID) {
      return this.toResult(json);
    }

    this.logger.warn(
      `bKash execute on ${paymentID} did not complete (${json?.statusMessage ?? json?.transactionStatus ?? 'no status'}) — querying`,
    );
    return this.status(cfg, paymentID);
  }

  /** The authoritative state of a payment. Used after a failed execute and for reconciliation. */
  async status(cfg: BkashCredentials, paymentID: string): Promise<BkashExecuteResult> {
    const json = await this.call(cfg, 'payment/status', { paymentID });
    return this.toResult(json);
  }

  private toResult(json: any): BkashExecuteResult {
    return {
      trxID: json?.trxID ?? '',
      paymentID: json?.paymentID ?? '',
      amount: fromTaka(json?.amount),
      status: json?.transactionStatus ?? json?.statusMessage ?? 'Unknown',
      raw: json ?? {},
    };
  }

  private async call(cfg: BkashCredentials, path: string, body: Record<string, unknown>): Promise<any> {
    const token = await this.token(cfg);
    const res = await fetch(`${this.base(cfg.sandbox)}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: token,
        'X-APP-Key': cfg.appKey,
      },
      body: JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
  }
}

/** bKash rejects numbers — the amount must be a decimal string with exactly 2 places. */
export function toTaka(poisha: number): string {
  return (poisha / 100).toFixed(2);
}

/** And parses back with rounding, so 1234.56 never becomes 123455 poisha. */
export function fromTaka(taka: unknown): number {
  const value = Number(taka ?? 0);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}
