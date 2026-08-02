import { Body, Controller, Delete, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { bdPhone, riderLocationSchema, type RiderLocationInput } from '@foodhub/shared';
import { OpsService } from './ops.service';
import { ReviewsModule } from '../reviews/reviews.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ReviewsService } from '../reviews/reviews.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, PlatformScope, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

const hoursSchema = z.object({
  autoOpenClose: z.boolean(),
  hours: z
    .array(z.object({ day: z.number().int().min(0).max(6), open: z.string(), close: z.string() }))
    .max(21),
});

@Controller('vendor/ops')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
@RequireTenant()
class VendorOpsController {
  constructor(
    private readonly ops: OpsService,
    private readonly reviews: ReviewsService,
  ) {}

  @Put('opening-hours')
  setHours(@CurrentTenant() tenant: RequestTenant, @Body(new ZodBody(hoursSchema)) dto: any) {
    return this.ops.setOpeningHours(tenant.id, dto.hours, dto.autoOpenClose);
  }

  /** "Sold out for today" — comes back by itself after midnight. */
  @Post('products/:id/sold-out')
  soldOut(
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ untilTomorrow: z.boolean().default(true) }))) dto: any,
  ) {
    return this.ops.markSoldOut(id, dto.untilTomorrow);
  }

  @Get('riders')
  riders(@CurrentTenant() tenant: RequestTenant) {
    return this.ops.listRiders(tenant.id);
  }

  @Post('riders')
  addRider(
    @CurrentTenant() tenant: RequestTenant,
    @Body(new ZodBody(z.object({ name: z.string().trim().min(2).max(60), phone: bdPhone }))) dto: any,
  ) {
    return this.ops.addRider(tenant.id, dto.name, dto.phone);
  }

  @Delete('riders/:id')
  removeRider(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.ops.removeRider(tenant.id, id);
  }

  @Post('orders/:id/rider')
  assign(
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ riderId: z.string().uuid().nullable() }))) dto: any,
  ) {
    return this.ops.assignRider(id, dto.riderId);
  }

  /** A vendor answering a review in public. */
  @Post('reviews/:id/reply')
  reply(
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ reply: z.string().trim().min(1).max(500) }))) dto: any,
  ) {
    return this.reviews.reply(id, dto.reply);
  }
}

@Controller('rider')
class RiderController {
  constructor(
    private readonly ops: OpsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * A rider's own run sheet.
   *
   * Addressed by a random token in the URL rather than a login: riders change often, half
   * of them will not install anything, and a link they can bookmark is the difference
   * between this being used and not.
   */
  @Public()
  @PlatformScope('a rider link carries its own token and resolves its own tenant')
  @Get('queue')
  queue(@Query('token') token: string) {
    return this.ops.riderQueue(token ?? '');
  }

  /**
   * The rider's phone reporting in, every thirty seconds while the run sheet is open.
   *
   * Returns how many customers that position reached, which is also what the rider's
   * screen shows them — "sharing with 2 deliveries" is a truthful, checkable statement
   * about who can see them, and it goes to zero the moment their last drop is done.
   */
  @Public()
  @PlatformScope('a rider reports position against its own run-sheet token')
  @Post('location')
  async location(@Body(new ZodBody(riderLocationSchema)) dto: RiderLocationInput) {
    const result = await this.ops.reportRiderLocation(dto);
    if (result.accepted) {
      for (const order of result.live) {
        this.realtime.emitRiderPosition(order.code, order.customerPhone, {
          lat: dto.lat,
          lng: dto.lng,
          at: result.at,
        });
      }
    }
    return { accepted: result.accepted, sharingWith: result.orders };
  }
}

@Module({
  imports: [ReviewsModule],
  controllers: [VendorOpsController, RiderController],
  providers: [OpsService],
  exports: [OpsService],
})
export class OpsModule {}
