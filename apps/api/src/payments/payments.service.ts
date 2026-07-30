import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Channel, GatewayConfigInput } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import { mockGatewayAvailable } from './mock-gateway';
import { BkashTransport, type BkashCredentials } from './bkash.transport';

interface CreateSessionInput {
  order: { id: string; code: string; total: number; customerPhone: string; deliveryAddress: any };
  channel: Channel;
  tenantId: string;
  method: 'SSLCOMMERZ' | 'BKASH' | 'NAGAD' | 'COD';
  /**
   * What to actually charge. Under a 50%-advance policy this is the advance, not the
   * total — the rider collects the rest at the door. Defaults to the whole order.
   */
  amount?: number;
}

/**
 * Two payment flows that must never be merged.
 *
 *   OWN_STORE   — the VENDOR'S own gateway credentials. Money goes customer -> vendor
 *                 directly; it never touches us and there is no commission to take.
 *                 We bill these vendors a fixed monthly fee instead.
 *
 *   MARKETPLACE — OUR gateway. Split-payout is requested so the gateway settles the
 *                 vendor's share directly and we only ever receive our commission.
 *                 Holding customer funds ourselves would put us in PSP/escrow territory
 *                 with Bangladesh Bank; split-payout is what keeps us out of it.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tenants: TenantService,
    private readonly bkash: BkashTransport,
  ) {}

  async createSession(input: CreateSessionInput) {
    const { order, channel, tenantId, method } = input;
    const charge = input.amount ?? order.total;
    if (charge <= 0) throw new BadRequestException('Nothing to pay for this order');

    const credentials =
      channel === 'OWN_STORE'
        ? await this.vendorCredentials(tenantId)
        : this.platformCredentials();

    const payment = await this.prisma.db.payment.create({
      data: {
        orderId: order.id,
        provider: credentials.provider,
        channel,
        amount: charge,
        status: 'INITIATED',
      },
    });

    if (!credentials.configured) {
      // No live credentials: hand back a local confirmation page so the whole pipeline —
      // order, webhook, settlement — stays exercisable in development. This is clearly
      // labelled a mock and refuses to run in production unless a deployment has
      // explicitly opted in (demo deployments with no merchant account).
      if (!this.mockAllowed()) {
        throw new BadRequestException(
          channel === 'OWN_STORE'
            ? 'This store has not connected a payment gateway yet'
            : 'Payment is temporarily unavailable',
        );
      }
      this.logger.warn(`No ${channel} gateway credentials — issuing a MOCK payment session for ${order.code}`);
      return {
        provider: 'MOCK',
        redirectUrl: `/pay/mock/${payment.id}`,
        mock: true,
      };
    }

    /*
     * Dispatch on the provider that is actually configured, not on what the customer
     * tapped. The button says "Card / bKash / Nagad" because that is the customer's mental
     * model; which merchant account the money runs through is the vendor's configuration,
     * and routing a bKash merchant's payment through SSLCommerz would simply fail.
     */
    if (credentials.provider === 'BKASH') {
      const redirectUrl = await this.openBkashSession(payment.id, order, charge, credentials.cfg);
      return { provider: 'BKASH', redirectUrl, mock: false };
    }

    const redirectUrl = await this.openSslcommerzSession(
      payment.id, order, charge, credentials, channel, tenantId,
    );
    return { provider: credentials.provider, redirectUrl, mock: false };
  }

  private async vendorCredentials(tenantId: string) {
    const cfg = await this.tenants.readGatewayConfig(tenantId);
    if (!cfg || cfg.provider === 'NONE') {
      return { provider: 'NONE', configured: false, sandbox: true, cfg: null };
    }
    return { provider: cfg.provider, configured: true, sandbox: cfg.sandbox, cfg };
  }

  /**
   * OUR merchant account for marketplace orders.
   *
   * bKash first when it is configured: it is the wallet most Bangladeshi customers
   * actually hold, and going straight to it skips an aggregator hop and its fee. SSLCommerz
   * remains the fallback because it covers cards and every other wallet in one integration.
   */
  private platformCredentials() {
    const b = this.config.get<BkashCredentials>('payments.bkash');
    if (b?.appKey && b?.appSecret && b?.username && b?.password) {
      return { provider: 'BKASH', configured: true, sandbox: b.sandbox, cfg: b as any };
    }

    const s = this.config.get<{ storeId: string; storePassword: string; sandbox: boolean }>(
      'payments.sslcommerz',
    );
    return {
      provider: 'SSLCOMMERZ',
      configured: Boolean(s?.storeId && s?.storePassword),
      sandbox: s?.sandbox ?? true,
      cfg: s ? ({ storeId: s.storeId, storePassword: s.storePassword, sandbox: s.sandbox } as any) : null,
    };
  }

  /**
   * Start a bKash payment and hand back the wallet URL.
   *
   * `providerRef` is stored before the customer leaves: the callback comes back carrying
   * only bKash's paymentID, and without that row we would have a paid customer and no way
   * to work out which order they paid for.
   */
  private async openBkashSession(
    paymentId: string,
    order: CreateSessionInput['order'],
    charge: number,
    cfg: BkashCredentials,
  ): Promise<string> {
    try {
      const created = await this.bkash.create(cfg, {
        amount: charge,
        // Our payment id, so the merchant statement lines up with our rows.
        invoice: paymentId,
        callbackUrl: `${this.apiBase()}/payments/bkash/callback`,
        payerReference: order.customerPhone,
      });

      await this.prisma.db.payment.update({
        where: { id: paymentId },
        data: { status: 'PENDING', providerRef: created.paymentID },
      });
      return created.bkashURL;
    } catch (err) {
      await this.prisma.db.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED', payload: { error: (err as Error).message } },
      });
      throw err;
    }
  }

  /**
   * bKash's return trip.
   *
   * This is the customer's own browser, not a server-to-server webhook — so it must end in
   * a redirect, and it must be safe to hit twice (a refresh, a back button). Both are
   * handled by keying everything on the stored `providerRef` and by letting the transport
   * fall back to a status query when execute reports an already-completed payment.
   */
  async handleBkashCallback(paymentID: string, status: string) {
    const payment = await TenantContext.runAsPlatform('gateway callback has no session', () =>
      this.prisma.db.payment.findFirst({
        where: { providerRef: paymentID },
        include: {
          order: { select: { id: true, code: true, tenantId: true, customerPhone: true, channel: true } },
        },
      }),
    );
    if (!payment) throw new NotFoundException('Unknown payment');

    // The customer cancelled or failed on bKash's own screen. Recorded, not retried.
    if (status && !['success', 'Success'].includes(status)) {
      await TenantContext.runAsTenant(payment.order.tenantId, () =>
        this.prisma.db.payment.update({
          where: { id: payment.id },
          data: { status: status.toLowerCase() === 'cancel' ? 'CANCELLED' : 'FAILED', payload: { status } },
        }),
      );
      return { ok: false, order: payment.order, reason: status };
    }

    const cfg =
      payment.channel === 'OWN_STORE'
        ? ((await this.tenants.readGatewayConfig(payment.order.tenantId)) as any)
        : this.config.get<BkashCredentials>('payments.bkash');
    if (!cfg) throw new BadRequestException('This store is no longer connected to bKash');

    const result = await this.bkash.execute(toBkashCredentials(cfg), paymentID);

    // The amount is checked against what WE asked for. A mismatch is not a payment, it is
    // an incident — recorded as such rather than quietly accepted.
    if (result.amount && result.amount !== payment.amount) {
      this.logger.error(
        `bKash amount mismatch on ${payment.id}: gateway says ${result.amount}, we charged ${payment.amount}`,
      );
      await TenantContext.runAsTenant(payment.order.tenantId, () =>
        this.prisma.db.payment.update({
          where: { id: payment.id },
          data: { status: 'MISMATCH', payload: result.raw as any },
        }),
      );
      return { ok: false, order: payment.order, reason: 'amount-mismatch' };
    }

    const completed = result.status === 'Completed';
    await TenantContext.runAsTenant(payment.order.tenantId, () =>
      this.prisma.db.payment.update({
        where: { id: payment.id },
        data: {
          status: completed ? 'PAID' : 'FAILED',
          gatewayRef: result.trxID || null,
          payload: result.raw as any,
        },
      }),
    );

    return { ok: completed, order: payment.order, ref: result.trxID };
  }

  private async openSslcommerzSession(
    paymentId: string,
    order: CreateSessionInput['order'],
    charge: number,
    credentials: { cfg: any; sandbox: boolean },
    channel: Channel,
    tenantId: string,
  ): Promise<string> {
    const base = credentials.sandbox
      ? 'https://sandbox.sslcommerz.com'
      : 'https://securepay.sslcommerz.com';

    const body = new URLSearchParams({
      store_id: credentials.cfg.storeId,
      store_passwd: credentials.cfg.storePassword,
      total_amount: (charge / 100).toFixed(2),
      currency: 'BDT',
      tran_id: paymentId,
      success_url: `${this.apiBase()}/payments/sslcommerz/ipn?status=success`,
      fail_url: `${this.apiBase()}/payments/sslcommerz/ipn?status=fail`,
      cancel_url: `${this.apiBase()}/payments/sslcommerz/ipn?status=cancel`,
      ipn_url: `${this.apiBase()}/payments/sslcommerz/ipn`,
      cus_name: order.deliveryAddress?.name ?? 'Customer',
      cus_phone: order.customerPhone,
      cus_add1: order.deliveryAddress?.addressLine ?? '',
      cus_city: order.deliveryAddress?.city ?? 'Dhaka',
      cus_country: 'Bangladesh',
      shipping_method: 'NO',
      product_name:
        charge < order.total ? `Order ${order.code} (advance)` : `Order ${order.code}`,
      product_category: 'Food',
      product_profile: 'general',
    });

    // Marketplace only: ask the gateway to settle the vendor's share straight to their
    // sub-merchant account, so the only money that ever lands with us is commission.
    if (channel === 'MARKETPLACE' && this.config.get<boolean>('payments.sslcommerz.splitPayout')) {
      body.set('value_a', tenantId);
      body.set('value_b', 'split');
    }

    const res = await fetch(`${base}/gwprocess/v4/api.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json: any = await res.json().catch(() => ({}));

    if (json?.status !== 'SUCCESS' || !json?.GatewayPageURL) {
      this.logger.error(`SSLCommerz session failed for ${order.code}: ${json?.failedreason ?? res.status}`);
      await this.prisma.db.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED', payload: json },
      });
      throw new BadRequestException('Could not start the payment — please try again');
    }

    await this.prisma.db.payment.update({
      where: { id: paymentId },
      data: { status: 'PENDING', gatewayRef: json.sessionkey ?? null, payload: json },
    });
    return json.GatewayPageURL as string;
  }

  /**
   * Gateway callback. Runs with no session, so it resolves its own tenant from the
   * payment row and verifies the amount against our record — a callback claiming a
   * different amount than the order is treated as a failure, not a payment.
   */
  async handleIpn(payload: Record<string, any>) {
    const tranId = payload.tran_id ?? payload.value_c;
    if (!tranId) throw new BadRequestException('Missing transaction id');

    const payment = await TenantContext.runAsPlatform('gateway IPN has no session', () =>
      this.prisma.db.payment.findUnique({
        where: { id: String(tranId) },
        include: {
          order: {
            select: { id: true, tenantId: true, total: true, advanceAmount: true, paymentStatus: true },
          },
        },
      }),
    );
    if (!payment) throw new NotFoundException('Unknown transaction');

    const success = ['VALID', 'VALIDATED', 'SUCCESS'].includes(String(payload.status ?? '').toUpperCase());
    const paidPoisha = Math.round(Number(payload.amount ?? 0) * 100);

    if (!success) {
      await TenantContext.runAsTenant(payment.order.tenantId, () =>
        this.prisma.db.payment.update({
          where: { id: payment.id },
          data: { status: 'FAILED', payload },
        }),
      );
      return { ok: false, orderId: payment.orderId };
    }

    // Checked against what we ASKED the gateway to charge, not the order total — under a
    // 50%-advance policy those are deliberately different, and comparing to the total
    // would reject every legitimate advance payment.
    if (paidPoisha && paidPoisha !== payment.amount) {
      this.logger.error(
        `IPN amount mismatch on payment ${payment.id}: gateway said ${paidPoisha}, we charged ${payment.amount}`,
      );
      await TenantContext.runAsTenant(payment.order.tenantId, () =>
        this.prisma.db.payment.update({
          where: { id: payment.id },
          data: { status: 'MISMATCH', payload },
        }),
      );
      throw new BadRequestException('Payment amount did not match the order');
    }

    await TenantContext.runAsTenant(payment.order.tenantId, () =>
      this.prisma.db.payment.update({
        where: { id: payment.id },
        data: { status: 'PAID', gatewayRef: payload.bank_tran_id ?? payload.val_id ?? null, payload },
      }),
    );

    return { ok: true, orderId: payment.orderId, ref: String(payload.bank_tran_id ?? payment.id) };
  }

  /** Confirms a mock session so the full pipeline can be walked without a gateway. */
  async confirmMock(paymentId: string) {
    if (!this.mockAllowed()) {
      throw new NotFoundException();
    }
    const payment = await TenantContext.runAsPlatform('mock payment confirmation', () =>
      this.prisma.db.payment.findUnique({
        where: { id: paymentId },
        include: { order: { select: { id: true, tenantId: true } } },
      }),
    );
    if (!payment) throw new NotFoundException('Unknown payment');

    await TenantContext.runAsTenant(payment.order.tenantId, () =>
      this.prisma.db.payment.update({
        where: { id: paymentId },
        data: { status: 'PAID', gatewayRef: `MOCK-${paymentId.slice(0, 8)}` },
      }),
    );
    return { orderId: payment.orderId, ref: `MOCK-${paymentId.slice(0, 8)}` };
  }

  /**
   * Whether the mock gateway may run here. Production says no unless the deployment has
   * explicitly opted in — see the config comment on `allowMockInProduction`.
   */
  private mockAllowed(): boolean {
    const allowed = mockGatewayAvailable(this.config);
    if (allowed && this.config.get<string>('env') === 'production') {
      this.logger.warn('DEMO_ALLOW_MOCK_PAYMENTS is on — orders can be marked paid without a gateway');
    }
    return allowed;
  }

  private apiBase(): string {
    return process.env.API_PUBLIC_URL ?? `http://127.0.0.1:${this.config.get<number>('port') ?? 4000}`;
  }
}

/**
 * The stored gateway config uses one shape for every provider, because a vendor form with
 * four different layouts is a vendor form nobody completes. bKash's four fields are pulled
 * out here rather than leaking that shape into the transport.
 */
export function toBkashCredentials(cfg: {
  appKey?: string; appSecret?: string; username?: string; passwordSecret?: string;
  storeId?: string; storePassword?: string; sandbox?: boolean; password?: string;
}): BkashCredentials {
  return {
    appKey: cfg.appKey ?? cfg.storeId ?? '',
    appSecret: cfg.appSecret ?? cfg.storePassword ?? '',
    username: cfg.username ?? '',
    // Platform config calls it `password`; the vendor envelope calls it `passwordSecret`.
    password: cfg.password ?? cfg.passwordSecret ?? '',
    sandbox: cfg.sandbox ?? true,
  };
}
