import { Body, Controller, Get, Global, Module, Post } from '@nestjs/common';
import { z } from 'zod';
import { bdPhone } from '@foodhub/shared';
import { RetentionService } from './retention.service';
import { PushService } from './push.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, PlatformScope, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

const subscribeSchema = z.object({
  endpoint: z.string().url().max(500),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(5).max(100) }),
  phone: bdPhone.optional(),
});

const rememberSchema = z.object({
  phone: bdPhone,
  items: z
    .array(z.object({ productId: z.string().uuid(), name: z.string().max(120), qty: z.number().int().min(1), price: z.number().int().min(0) }))
    .min(1)
    .max(50),
  subtotal: z.number().int().min(0),
});

const recurringSchema = z.object({
  phone: bdPhone,
  items: z.array(z.object({ productId: z.string().uuid(), qty: z.number().int().min(1).max(20) })).min(1).max(20),
  address: z.record(z.any()),
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  timeOfDay: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 08:00'),
});

@Controller('storefront')
class StorefrontRetentionController {
  constructor(
    private readonly retention: RetentionService,
    private readonly push: PushService,
  ) {}

  /** The browser needs the public VAPID key before it can subscribe. */
  @Public()
  @Get('push/key')
  key() {
    return { publicKey: this.push.publicKey, enabled: this.push.configured };
  }

  @Public()
  @RequireTenant()
  @Post('push/subscribe')
  subscribe(@CurrentTenant() tenant: RequestTenant, @Body(new ZodBody(subscribeSchema)) dto: any) {
    return this.push.subscribe({
      tenantId: tenant.id,
      endpoint: dto.endpoint,
      p256dh: dto.keys.p256dh,
      auth: dto.keys.auth,
      phone: dto.phone,
    });
  }

  @Public()
  @Post('push/unsubscribe')
  unsubscribe(@Body(new ZodBody(z.object({ endpoint: z.string().url() }))) dto: any) {
    return this.push.unsubscribe(dto.endpoint);
  }

  /**
   * Remember a basket for recovery.
   *
   * Fired from checkout the moment a valid phone number is typed — the earliest point at
   * which there is somebody to remind.
   */
  @Public()
  @RequireTenant()
  @Post('cart/remember')
  remember(@CurrentTenant() tenant: RequestTenant, @Body(new ZodBody(rememberSchema)) dto: any) {
    return this.retention.rememberCart(tenant.id, dto.phone, dto.items, dto.subtotal);
  }

  @Public()
  @RequireTenant()
  @Post('recurring')
  createRecurring(@CurrentTenant() tenant: RequestTenant, @Body(new ZodBody(recurringSchema)) dto: any) {
    return this.retention.createRecurring(tenant.id, dto);
  }
}

@Controller('vendor/retention')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
class VendorRetentionController {
  constructor(private readonly retention: RetentionService) {}

  /** How much money the recovery reminders actually brought back. */
  @Get('carts')
  carts(@CurrentUser() user: AuthedUser) {
    return this.retention.cartStats(user.tenantId as string);
  }
}

@Global()
@Module({
  controllers: [StorefrontRetentionController, VendorRetentionController],
  providers: [RetentionService, PushService],
  exports: [RetentionService, PushService],
})
export class RetentionModule {}
