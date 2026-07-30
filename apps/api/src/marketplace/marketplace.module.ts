import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { VENDOR_SORTS, type VendorSort } from '@foodhub/shared';
import { ReviewsModule } from '../reviews/reviews.module';
import { MarketplaceService } from './marketplace.service';
import { PlatformScope, Public } from '../common/decorators';
import { EdgeCache } from '../common/cache-headers.interceptor';

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `?openNow`, `?openNow=1` and `?openNow=true` all mean the same thing to a filter UI. */
function flag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value === '' || value === '1' || value.toLowerCase() === 'true';
}

@Controller('marketplace')
@Public()
@PlatformScope('mother marketplace reads across all listed vendors')
class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @EdgeCache({ sMaxAge: 60, staleWhileRevalidate: 600 })
  @Get('vendors')
  vendors(
    @Query('lat') lat?: string,
    @Query('lng') lng?: string,
    @Query('radiusKm') radiusKm?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('cuisine') cuisine?: string,
    @Query('openNow') openNow?: string,
    @Query('freeDelivery') freeDelivery?: string,
    @Query('maxDeliveryFee') maxDeliveryFee?: string,
    @Query('sort') sort?: string,
  ) {
    return this.marketplace.listVendors({
      lat: num(lat),
      lng: num(lng),
      radiusKm: num(radiusKm),
      page: num(page),
      pageSize: num(pageSize),
      // Repeatable or comma-separated, because both are what a filter UI produces.
      cuisines: cuisine ? cuisine.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 6) : undefined,
      openNow: flag(openNow),
      freeDelivery: flag(freeDelivery),
      maxDeliveryFee: num(maxDeliveryFee),
      // An unknown sort falls back to the house order rather than 400-ing: a stale
      // bookmark should still show restaurants.
      sort: (VENDOR_SORTS as readonly string[]).includes(sort ?? '') ? (sort as VendorSort) : undefined,
    });
  }

  /**
   * The filter chips, and only the ones that lead somewhere. Built from what vendors
   * actually carry, so a chip can never return an empty list.
   */
  @EdgeCache({ sMaxAge: 300, staleWhileRevalidate: 3600 })
  @Get('cuisines')
  cuisines() {
    return this.marketplace.cuisineFacets();
  }

  @EdgeCache({ sMaxAge: 60, staleWhileRevalidate: 600 })
  @Get('vendors/:slug')
  vendor(@Param('slug') slug: string) {
    return this.marketplace.getVendorMenu(slug);
  }

  @Get('search')
  search(@Query('q') q: string, @Query('limit') limit?: string) {
    return this.marketplace.search(q ?? '', num(limit) ?? 20);
  }
}

@Module({
  imports: [ReviewsModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
