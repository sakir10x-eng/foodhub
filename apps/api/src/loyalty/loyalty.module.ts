import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { bdPhone } from '@foodhub/shared';
import { LoyaltyService } from './loyalty.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';
import { RateLimit } from '../infra/rate-limit.guard';

const creditSchema = z.object({
  phone: bdPhone,
  amount: z.number().int().min(1).max(50_000_00),
  memo: z.string().trim().max(200).default('Store credit'),
});

@Controller('storefront/loyalty')
class StorefrontLoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  /**
   * A customer's points at this vendor, looked up by phone.
   *
   * Rate-limited by phone: the endpoint is public (guests have no login), so without a
   * cap it would be an enumeration oracle for "which numbers order here".
   */
  @Public()
  @RequireTenant()
  @RateLimit({ limit: 20, windowSeconds: 60, by: 'phone' })
  @Get('balance')
  balance(@CurrentTenant() tenant: RequestTenant, @Query('phone') phone?: string) {
    if (!phone) return { points: 0, wallet: 0, lifetimePoints: 0, tier: 'BRONZE', redeemableValue: 0 };
    return this.loyalty.balance(tenant.id, phone);
  }
}

@Controller('vendor/loyalty')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
class VendorLoyaltyController {
  constructor(private readonly loyalty: LoyaltyService) {}

  @Get('customers')
  top(@CurrentUser() user: AuthedUser) {
    return this.loyalty.topCustomers(user.tenantId as string);
  }

  @Get('history')
  history(@CurrentUser() user: AuthedUser, @Query('phone') phone: string) {
    return this.loyalty.history(user.tenantId as string, phone ?? '');
  }

  /** Goodwill credit — refunds, apologies, promotions. Owner-only: it is real money. */
  @Roles('VENDOR_OWNER')
  @Post('credit')
  credit(@CurrentUser() user: AuthedUser, @Body(new ZodBody(creditSchema)) dto: any) {
    return this.loyalty.grantCredit(user.tenantId as string, dto.phone, dto.amount, dto.memo);
  }
}

@Module({
  controllers: [StorefrontLoyaltyController, VendorLoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
