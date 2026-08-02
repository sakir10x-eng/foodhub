import { Body, Controller, Delete, Get, Module, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { bdPhone, riderLocationSchema, type RiderLocationInput } from '@foodhub/shared';
import { OpsService } from './ops.service';
import { ReviewsModule } from '../reviews/reviews.module';
import { OrdersModule } from '../orders/orders.module';
import { RiderLedgerModule } from '../rider-ledger/rider-ledger.module';
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

  /** Let a delivery through without the customer's code. Recorded as an OrderEvent. */
  @Post('orders/:id/release-proof')
  releaseProof(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
  ) {
    return this.ops.releaseDeliveryProof(tenant.id, id, `vendor:${user.id}`);
  }

  /** How a rider has been doing. Every number counted from something that happened. */
  @Get('riders/:id/performance')
  async performance(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    // Only for a rider this shop actually works with.
    await this.ops.areasForShop(tenant.id, id);
    return this.ops.riderPerformance(id);
  }

  @Get('rider-alerts')
  alerts(@CurrentTenant() tenant: RequestTenant) {
    return this.ops.shopAlerts(tenant.id);
  }

  @Post('rider-alerts/:id/resolve')
  resolveAlert(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.ops.resolveAlert(tenant.id, id);
  }

  /**
   * "We have run out of this."
   *
   * Only downwards, only before the rider collects it, and every change is written to the
   * order's event log with the name of whoever made it.
   */
  @Post('orders/:id/out-of-stock')
  outOfStock(
    @CurrentTenant() tenant: RequestTenant,
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(z.object({
      supplied: z.array(z.object({
        itemId: z.string().uuid(),
        qty: z.number().int().min(0).max(999),
      })).min(1).max(100),
    })))
    dto: any,
  ) {
    return this.ops.repriceForStock(tenant.id, id, dto.supplied, `vendor:${user.id}`);
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

  /** The run: every counter and every door, in order, with the next one marked. */
  @Public()
  @PlatformScope('a rider reads its own run against its own run-sheet token')
  @Post('trip')
  trip(@Body(new ZodBody(z.object({ token: z.string().min(1) }))) dto: any) {
    return this.ops.tripSheet(dto.token);
  }

  /** Sort what is still ahead and start riding. Completed stops are never reordered. */
  @Public()
  @PlatformScope('a rider plans its own run against its own run-sheet token')
  @Post('trip/plan')
  planTrip(@Body(new ZodBody(z.object({ token: z.string().min(1) }))) dto: any) {
    return this.ops.planTrip(dto.token);
  }

  /** Collected at a counter, or handed over at a door — with the customer's code if asked. */
  @Public()
  @PlatformScope('a rider completes a stop on its own run against its own run-sheet token')
  @Post('trip/stop')
  completeStop(
    @Body(new ZodBody(z.object({
      token: z.string().min(1),
      stopId: z.string().uuid(),
      otp: z.string().trim().max(10).optional(),
    })))
    dto: any,
  ) {
    return this.ops.completeStop(dto.token, dto.stopId, dto.otp);
  }

  /** Knocked, and it did not happen. Goes to the end of the run to be tried again. */
  @Public()
  @PlatformScope('a rider records a failed attempt on its own run against its own run-sheet token')
  @Post('trip/failed')
  failStop(
    @Body(new ZodBody(z.object({
      token: z.string().min(1),
      stopId: z.string().uuid(),
      reason: z.enum(['NO_ANSWER', 'WRONG_ADDRESS', 'REFUSED', 'NO_CASH', 'OTHER']),
      note: z.string().trim().max(300).optional(),
    })))
    dto: any,
  ) {
    return this.ops.failStop(dto.token, dto.stopId, dto.reason, dto.note);
  }

  /** Taking it back to the shop. */
  @Public()
  @PlatformScope('a rider returns a parcel on its own run against its own run-sheet token')
  @Post('trip/return')
  returnStop(
    @Body(new ZodBody(z.object({ token: z.string().min(1), stopId: z.string().uuid() }))) dto: any,
  ) {
    return this.ops.returnStop(dto.token, dto.stopId);
  }

  /**
   * The rider accepting or declining a shop that has asked to work with them.
   *
   * Authorised by the same token as the run sheet, because that token is already the proof
   * of who they are — requiring a login here would mean the consent step could not ship
   * until riders had accounts, and the invitation is what makes sharing a rider safe.
   */
  /** What they ride and who to call. Theirs to set — only they know what fits. */
  @Public()
  @PlatformScope('a rider reads its own profile against its own run-sheet token')
  @Post('profile')
  profile(
    @Body(new ZodBody(z.object({
      token: z.string().min(1),
      vehicle: z.enum(['BICYCLE', 'MOTORCYCLE', 'VAN', 'FOOT']).optional(),
      capacityKg: z.number().int().min(1).max(500).optional(),
      emergencyPhone: bdPhone.nullish(),
    })))
    dto: any,
  ) {
    const { token, ...rest } = dto;
    return Object.keys(rest).length > 0
      ? this.ops.setRiderProfile(token, rest)
      : this.ops.riderProfile(token);
  }

  /** Something has gone wrong. One tap; the position comes from their last fix. */
  @Public()
  @PlatformScope('a rider raises an alert against its own run-sheet token')
  @Post('alert')
  alert(
    @Body(new ZodBody(z.object({
      token: z.string().min(1),
      kind: z.enum(['ACCIDENT', 'BREAKDOWN', 'UNSAFE', 'OTHER']),
      note: z.string().trim().max(300).optional(),
    })))
    dto: any,
  ) {
    return this.ops.raiseAlert(dto.token, dto.kind, dto.note);
  }

  /** What the rider is carrying and what they have earned. Their own money, their screen. */
  @Public()
  @PlatformScope('a rider reads its own money against its own run-sheet token')
  @Post('money')
  money(@Body(new ZodBody(z.object({ token: z.string().min(1) }))) dto: any) {
    return this.ops.riderMoney(dto.token);
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
  // OrdersModule for OrdersService: a rider completing a drop must move the order through
  // the same code a vendor does, or DELIVERED would skip settlement and loyalty.
  imports: [ReviewsModule, OrdersModule, RiderLedgerModule],
  controllers: [VendorOpsController, RiderController],
  providers: [OpsService],
  exports: [OpsService],
})
export class OpsModule {}
