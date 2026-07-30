import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { bdPhone } from '@foodhub/shared';
import { ReferralsService } from './referrals.service';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, Public, RequireTenant } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

@Controller('storefront/referral')
class ReferralController {
  constructor(private readonly referrals: ReferralsService) {}

  /** The customer's own code, plus what each side gets. */
  @Public()
  @RequireTenant()
  @Get()
  code(@CurrentTenant() tenant: RequestTenant, @Query('phone') phone: string) {
    return this.referrals.codeFor(tenant.id, bdPhone.parse(phone ?? ''));
  }

  @Public()
  @RequireTenant()
  @Get('stats')
  stats(@CurrentTenant() tenant: RequestTenant, @Query('phone') phone: string) {
    return this.referrals.statsFor(tenant.id, bdPhone.parse(phone ?? ''));
  }

  @Public()
  @RequireTenant()
  @Post('claim')
  claim(
    @CurrentTenant() tenant: RequestTenant,
    @Body(new ZodBody(z.object({ code: z.string().trim().min(4).max(12), phone: bdPhone }))) dto: any,
  ) {
    return this.referrals.claim(tenant.id, dto.code, dto.phone);
  }
}

@Module({
  imports: [LoyaltyModule],
  controllers: [ReferralController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class MarketingModule {}
