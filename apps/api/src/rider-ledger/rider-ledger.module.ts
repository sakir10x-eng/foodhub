import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { RiderLedgerService } from './rider-ledger.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

/**
 * The shop's end-of-day reconciliation.
 *
 * Deliberately a vendor screen and not an automated sweep: cash changes hands between two
 * people, and the record of that should be made by one of them.
 */
@Controller('vendor/rider-money')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
@RequireTenant()
class RiderMoneyController {
  constructor(private readonly ledger: RiderLedgerService) {}

  /** Who is carrying what, right now. */
  @Get()
  overview(@CurrentTenant() tenant: RequestTenant) {
    return this.ledger.shopOverview(tenant.id);
  }

  @Get(':riderId/statement')
  statement(@Param('riderId') riderId: string, @Query('take') take?: string) {
    return this.ledger.statement(riderId, Math.min(200, Number(take) || 50));
  }

  /** "I have taken this much cash off them." */
  @Post(':riderId/deposit')
  deposit(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentUser() user: AuthedUser,
    @Param('riderId') riderId: string,
    @Body(new ZodBody(z.object({
      amount: z.number().int().positive(),
      memo: z.string().trim().max(200).optional(),
    })))
    dto: any,
  ) {
    return this.ledger.deposit(tenant.id, riderId, dto.amount, `vendor:${user.id}`, dto.memo);
  }

  /** Paying wages, or correcting them — an adjustment must carry a reason. */
  @Post(':riderId/settle')
  settle(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentUser() user: AuthedUser,
    @Param('riderId') riderId: string,
    @Body(new ZodBody(z.object({
      amount: z.number().int(),
      type: z.enum(['PAYOUT', 'ADJUSTMENT']),
      memo: z.string().trim().max(200).optional(),
    })))
    dto: any,
  ) {
    return this.ledger.settleEarnings(tenant.id, riderId, dto.amount, dto.type, `vendor:${user.id}`, dto.memo);
  }
}

@Module({
  controllers: [RiderMoneyController],
  providers: [RiderLedgerService],
  exports: [RiderLedgerService],
})
export class RiderLedgerModule {}
