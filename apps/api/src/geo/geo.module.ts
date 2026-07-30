import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { matchZone, requiresLocation, type DeliveryZone } from '@foodhub/shared';
import { GeoService } from './geo.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, Public, RequireTenant } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/**
 * Address lookup for the map picker, and the answer to "do you deliver here?".
 *
 * Both are public: they happen before an order exists, and before we have any reason to
 * know who is asking. Both are also cheap and cached, and the global per-IP rate limiter
 * already covers them.
 */
@Controller('geo')
class GeoController {
  constructor(private readonly geo: GeoService) {}

  /** Pin → address, for filling the form after somebody drags the map. */
  @Public()
  @Get('reverse')
  async reverse(@Query('lat') lat: string, @Query('lng') lng: string) {
    const parsed = pointSchema.safeParse({ lat: Number(lat), lng: Number(lng) });
    if (!parsed.success) return { place: null };
    const place = await this.geo.reverse(parsed.data.lat, parsed.data.lng);
    return { place, provider: this.geo.provider };
  }

  /** Typed text → places, so a customer can find their road instead of hunting for it. */
  @Public()
  @Get('search')
  async search(@Query('q') q: string) {
    return { places: await this.geo.search(q ?? ''), provider: this.geo.provider };
  }
}

/**
 * "Do you deliver to this pin?", asked from the checkout page the moment a location is
 * chosen — long before the customer has filled in their name and phone.
 *
 * It answers with the SAME function checkout uses to accept or refuse the order, so the
 * two can never disagree. What it deliberately does not do is decide anything: the price
 * and the acceptance are still settled server-side when the order is actually placed.
 */
@Controller('storefront/delivery')
class DeliveryAreaController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @RequireTenant()
  @Post('check')
  async check(@CurrentTenant() tenant: RequestTenant, @Body(new ZodBody(pointSchema)) point: any) {
    const row = await TenantContext.runAsPlatform('delivery area check for one explicit tenant', () =>
      this.prisma.db.tenant.findUnique({
        where: { id: tenant.id },
        select: { name: true, deliveryZones: true },
      }),
    );
    const zones = ((row?.deliveryZones ?? []) as unknown as DeliveryZone[]) ?? [];
    const match = matchZone(zones, { point });

    return {
      serviceable: !match.outsideServiceArea && !!match.zone,
      /** True when this vendor cannot take a delivery order without a pin at all. */
      locationRequired: requiresLocation(zones),
      zone: match.zone
        ? { id: match.zone.id, label: match.zone.label, fee: match.zone.fee, minOrder: match.zone.minOrder }
        : null,
      message: match.outsideServiceArea
        ? `${row?.name ?? 'This restaurant'} does not deliver to that location yet`
        : null,
    };
  }
}

@Module({
  controllers: [GeoController, DeliveryAreaController],
  providers: [GeoService],
  exports: [GeoService],
})
export class GeoModule {}
