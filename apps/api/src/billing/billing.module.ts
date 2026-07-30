import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { BillingService } from './billing.service';
import { SettlementsService } from '../settlements/settlements.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentUser, PlatformScope, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';

const planSchema = z.object({ plan: z.enum(['FREE', 'BASIC', 'PRO']) });
const paySchema = z.object({ paymentRef: z.string().trim().min(3).max(120) });

@Controller('vendor/billing')
@Roles('VENDOR_OWNER')
class VendorBillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly settlements: SettlementsService,
  ) {}

  @Get('subscription')
  subscription(@CurrentUser() user: AuthedUser) {
    return this.billing.getSubscription(user.tenantId as string);
  }

  @Get('invoices')
  invoices(@CurrentUser() user: AuthedUser) {
    return this.billing.listInvoices(user.tenantId as string);
  }

  @Post('plan')
  changePlan(@CurrentUser() user: AuthedUser, @Body(new ZodBody(planSchema)) dto: any) {
    return this.billing.changePlan(user.tenantId as string, dto.plan);
  }

  @Post('invoices/:id/pay')
  pay(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(paySchema)) dto: { paymentRef: string },
  ) {
    return this.billing.payInvoice(user.tenantId as string, id, dto.paymentRef);
  }

  /** Marketplace payouts owed to this vendor (Mode B money). */
  @Get('settlements')
  listSettlements(@CurrentUser() user: AuthedUser) {
    return this.settlements.list(user.tenantId as string);
  }
}

@Controller('platform/settlements')
@Roles('PLATFORM_ADMIN')
@PlatformScope('platform admin manages payouts across vendors')
class PlatformSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  /** Force a rollup outside the weekly cron (e.g. an on-demand payout request). */
  @Post('run')
  run(
    @Body(new ZodBody(z.object({ tenantId: z.string().uuid() })))
    dto: { tenantId: string },
  ) {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    return this.settlements.settleTenant(dto.tenantId, start, end);
  }

  @Get()
  list(@Query('status') status?: 'PENDING' | 'PAID') {
    return this.settlements.listAll(status);
  }

  @Get(':id')
  one(@Param('id') id: string) {
    return this.settlements.getOne(id);
  }

  @Post(':id/paid')
  markPaid(@Param('id') id: string, @Body(new ZodBody(paySchema)) dto: { paymentRef: string }) {
    return this.settlements.markPaid(id, dto.paymentRef);
  }
}

@Module({
  controllers: [VendorBillingController, PlatformSettlementsController],
  providers: [BillingService, SettlementsService],
  exports: [BillingService, SettlementsService],
})
export class BillingModule {}
