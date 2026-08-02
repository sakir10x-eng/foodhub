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

const geoPoint = z.object({ lat: z.number(), lng: z.number() });

/**
 * One patch a rider covers.
 *
 * Every part of the shape is optional because in a village most patches will be nothing
 * but a list of names — a polygon needs a map, a map needs a signal, and neither is
 * guaranteed. An empty shape is allowed through and simply matches nothing, which is the
 * honest result of describing a place with no information.
 */
const riderAreaSchema = z.object({
  label: z.string().trim().min(1).max(60),
  shape: z.object({
    areas: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
    center: geoPoint.nullish(),
    radiusKm: z.number().positive().max(50).nullish(),
    polygon: z.array(geoPoint).max(200).nullish(),
  }),
});

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

  @Get('riders/:id/areas')
  riderAreas(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.ops.areasForShop(tenant.id, id);
  }

  /** Which villages this rider covers. Replaces the whole list — see setAreas. */
  @Put('riders/:id/areas')
  setRiderAreas(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ areas: z.array(riderAreaSchema).max(20) }))) dto: any,
  ) {
    return this.ops.setAreas(tenant.id, id, dto.areas);
  }

  @Post('orders/:id/rider')
  assign(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ riderId: z.string().uuid().nullable() }))) dto: any,
  ) {
    return this.ops.assignRider(tenant.id, id, dto.riderId);
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

  /**
   * The rider accepting or declining a shop that has asked to work with them.
   *
   * Authorised by the same token as the run sheet, because that token is already the proof
   * of who they are — requiring a login here would mean the consent step could not ship
   * until riders had accounts, and the invitation is what makes sharing a rider safe.
   */
  /** Going on or off the road. Off is the default, and only the rider flips it. */
  @Public()
  @PlatformScope('a rider goes on duty against its own run-sheet token')
  @Post('duty')
  duty(@Body(new ZodBody(z.object({ token: z.string().min(1), onDuty: z.boolean() }))) dto: any) {
    return this.ops.setDuty(dto.token, dto.onDuty);
  }

  /**
   * Deliveries waiting in this rider's patch.
   *
   * Deliberately POST-with-token rather than a GET query string: this is the one rider
   * endpoint that lists work the rider does not yet own, and a token in a URL ends up in
   * proxy logs, browser history and anything pasted into a chat.
   */
  @Public()
  @PlatformScope('a rider lists work in its own areas against its own run-sheet token')
  @Post('available')
  available(@Body(new ZodBody(z.object({ token: z.string().min(1) }))) dto: any) {
    return this.ops.availableWork(dto.token);
  }

  @Public()
  @PlatformScope('a rider claims a delivery against its own run-sheet token')
  @Post('accept')
  accept(
    @Body(new ZodBody(z.object({ token: z.string().min(1), orderId: z.string().uuid() }))) dto: any,
  ) {
    return this.ops.acceptWork(dto.token, dto.orderId);
  }

  @Public()
  @PlatformScope('a rider passes on a delivery against its own run-sheet token')
  @Post('skip')
  skip(
    @Body(new ZodBody(z.object({ token: z.string().min(1), orderId: z.string().uuid() }))) dto: any,
  ) {
    return this.ops.skipWork(dto.token, dto.orderId);
  }

  @Public()
  @PlatformScope('a rider answers an invitation against its own run-sheet token')
  @Post('invites')
  respond(
    @Body(new ZodBody(z.object({
      token: z.string().min(1),
      tenantId: z.string().uuid(),
      accept: z.boolean(),
    })))
    dto: any,
  ) {
    return this.ops.respondToInvite(dto.token, dto.tenantId, dto.accept);
  }
}

@Module({
  imports: [ReviewsModule],
  controllers: [VendorOpsController, RiderController],
  providers: [OpsService],
  exports: [OpsService],
})
export class OpsModule {}
