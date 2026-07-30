import { Controller, Get, Module, Param, Query } from '@nestjs/common';
import { ReviewsModule } from '../reviews/reviews.module';
import { MarketplaceService } from './marketplace.service';
import { PlatformScope, Public } from '../common/decorators';
import { EdgeCache } from '../common/cache-headers.interceptor';

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
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
  ) {
    return this.marketplace.listVendors({
      lat: num(lat),
      lng: num(lng),
      radiusKm: num(radiusKm),
      page: num(page),
      pageSize: num(pageSize),
    });
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
