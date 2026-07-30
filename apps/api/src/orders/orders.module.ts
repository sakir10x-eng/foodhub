import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Module,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  checkoutSchema,
  marketplaceCheckoutSchema,
  orderCancelSchema,
  orderStatusUpdateSchema,
  reviewSchema,
  OrderStatus,
} from '@foodhub/shared';
import { OrdersService } from './orders.service';
import { CheckoutService } from './checkout.service';
import { PaymentsService } from '../payments/payments.service';
import { LedgerService } from '../ledger/ledger.service';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ReviewsService } from '../reviews/reviews.service';
import { BkashTransport } from '../payments/bkash.transport';
import { ReviewsModule } from '../reviews/reviews.module';
import { RetentionModule } from '../retention/retention.module';
import { MarketingModule } from '../marketing/marketing.module';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, PlatformScope, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

@Controller('storefront')
class StorefrontCheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /** Mode A checkout: the vendor's own site, the vendor's own gateway, no commission. */
  @Public()
  @RequireTenant()
  @Post('checkout')
  place(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentUser() user: AuthedUser | null,
    @Body(new ZodBody(checkoutSchema)) dto: any,
  ) {
    return this.checkout.placeOrder(dto, {
      channel: 'OWN_STORE',
      tenantId: tenant.id,
      customerId: user?.role === 'CUSTOMER' ? user.id : null,
    });
  }
}

@Controller('marketplace')
class MarketplaceCheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  /** Mode B checkout: our site, our gateway, commission taken. One vendor per order. */
  @Public()
  @PlatformScope('marketplace checkout targets one vendor chosen in the request body')
  @Post('checkout')
  place(@CurrentUser() user: AuthedUser | null, @Body(new ZodBody(marketplaceCheckoutSchema)) dto: any) {
    return this.checkout.placeOrder(dto, {
      channel: 'MARKETPLACE',
      tenantId: dto.tenantId,
      customerId: user?.role === 'CUSTOMER' ? user.id : null,
    });
  }
}

@Controller('vendor/orders')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
class VendorOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  list(
    @Query('status') status?: string,
    @Query('channel') channel?: 'OWN_STORE' | 'MARKETPLACE',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.orders.list({
      status: status ? (status.split(',') as OrderStatus[]) : undefined,
      channel,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** The kitchen screen. */
  @Get('queue')
  queue() {
    return this.orders.activeQueue();
  }

  @Get('stats')
  stats(@Query('days') days?: string) {
    return this.orders.stats(days ? Number(days) : 7);
  }

  @Get('statement')
  statement(@CurrentUser() user: AuthedUser, @Query('page') page?: string) {
    return this.ledger.statement(user.tenantId as string, { page: page ? Number(page) : 1 });
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.orders.getOne(id);
  }

  @Post(':id/status')
  updateStatus(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(orderStatusUpdateSchema)) dto: { status: OrderStatus; note?: string },
  ) {
    return this.orders.updateStatus(id, dto.status, user.id, dto.note);
  }
}

@Controller()
class CustomerOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly reviews: ReviewsService,
  ) {}

  /** Guest tracking — order code plus the phone it was placed with. */
  @Public()
  @PlatformScope('guest order tracking spans vendors and has no session')
  @Get('orders/track')
  track(@Query('code') code: string, @Query('phone') phone: string) {
    if (!code || !phone) throw new BadRequestException('Enter your order number and phone');
    return this.orders.trackGuest(code, phone);
  }

  /**
   * Rate a delivered order. Guest-authorised the same way tracking is — order code plus
   * the phone that placed it — so a rating cannot exist without a real order behind it.
   */
  @Public()
  @PlatformScope('a guest rates their own order, identified by code + phone')
  @Post('orders/review')
  review(@Body(new ZodBody(reviewSchema)) dto: any) {
    return this.reviews.submit(dto);
  }

  /**
   * Call off an order. Same guest authorisation as tracking, because the customer who
   * needs this most is the one who ordered without making an account.
   */
  @Public()
  @PlatformScope('a guest cancels their own order, identified by code + phone')
  @Post('orders/cancel')
  cancel(@Body(new ZodBody(orderCancelSchema)) dto: { code: string; phone: string; reason?: string }) {
    return this.orders.cancelByCustomer(dto.code, dto.phone, dto.reason);
  }

  @Roles('CUSTOMER')
  @PlatformScope('a customer reads their own orders across vendors')
  @Get('account/orders')
  mine(@CurrentUser() user: AuthedUser) {
    return this.orders.listForCustomer(user.id);
  }
}

@Controller('payments')
class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly orders: OrdersService,
  ) {}

  /**
   * bKash's return trip.
   *
   * Unlike an IPN this is the CUSTOMER'S OWN BROWSER coming back from the wallet, so it
   * has to end in a redirect to a page a human can read — returning JSON here would leave
   * someone who has just paid staring at `{"ok":true}`.
   *
   * GET, because bKash redirects rather than posting, and safe to hit twice: a refresh or
   * a back button re-runs it, and the execute path resolves an already-completed payment
   * by querying its real status instead of failing.
   */
  @Public()
  @PlatformScope('gateway callback arrives without a session')
  @Get('bkash/callback')
  async bkashCallback(
    @Query('paymentID') paymentID: string,
    @Query('status') status: string,
    @Res() res: Response,
  ) {
    if (!paymentID) {
      res.redirect(302, '/checkout?failed=1');
      return;
    }

    try {
      const result = await this.payments.handleBkashCallback(paymentID, status ?? '');
      if (result.ok) {
        await this.orders.markPaid(result.order.id, result.ref!, 'callback:bkash');
        res.redirect(
          302,
          `/order/${result.order.code}?phone=${encodeURIComponent(result.order.customerPhone)}`,
        );
        return;
      }
      // Cancelled or failed at the wallet: back to checkout with the basket intact.
      res.redirect(302, `/checkout?failed=1&reason=${encodeURIComponent(result.reason ?? 'failed')}`);
    } catch {
      // A customer who may well have paid must never see a stack trace. The payment row
      // carries the truth and reconciliation will pick it up.
      res.redirect(302, '/checkout?failed=1&reason=error');
    }
  }

  /**
   * Gateway IPN. Public because the gateway calls it server-to-server; the transaction
   * id is the secret and the amount is re-checked against our own record.
   */
  @Public()
  @PlatformScope('gateway IPN arrives without a session')
  @Post('sslcommerz/ipn')
  async ipn(@Body() body: Record<string, any>, @Res() res: Response) {
    const result = await this.payments.handleIpn(body);
    if (result.ok) await this.orders.markPaid(result.orderId, result.ref!, 'webhook:sslcommerz');
    res.status(200).send('OK');
  }

  /** Dev-only mock confirmation so the pipeline is walkable without a live gateway. */
  @Public()
  @PlatformScope('mock gateway confirmation in development')
  @Post('mock/:id/confirm')
  async mock(@Param('id') id: string) {
    const result = await this.payments.confirmMock(id);
    const order = await this.orders.markPaid(result.orderId, result.ref, 'mock-gateway');
    return { ok: true, order };
  }
}

@Module({
  // Loyalty is imported rather than re-provided: points and store credit are money, and
  // two instances of the service would be two independent views of the same balance.
  imports: [LoyaltyModule, ReviewsModule, RetentionModule, MarketingModule],
  controllers: [
    StorefrontCheckoutController,
    MarketplaceCheckoutController,
    VendorOrdersController,
    CustomerOrdersController,
    PaymentsController,
  ],
  providers: [OrdersService, CheckoutService, PaymentsService, LedgerService, BkashTransport],
  exports: [OrdersService, CheckoutService, LedgerService],
})
export class OrdersModule {}
