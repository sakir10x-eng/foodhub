import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { AnalyticsService } from './analytics.service';
import { RecommendationsService } from './recommendations.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, PlatformScope, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';
import { EdgeCache } from '../common/cache-headers.interceptor';

const days = (v?: string) => Math.min(365, Math.max(1, Number(v) || 30));

@Controller('vendor/analytics')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
class VendorAnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly recs: RecommendationsService,
  ) {}

  @Get('overview')
  overview(@CurrentUser() user: AuthedUser, @Query('days') d?: string) {
    return this.analytics.overview(user.tenantId as string, days(d));
  }

  @Get('best-sellers')
  bestSellers(@CurrentUser() user: AuthedUser, @Query('days') d?: string, @Query('limit') limit?: string) {
    return this.analytics.bestSellers(user.tenantId as string, days(d), Math.min(50, Number(limit) || 10));
  }

  @Get('peak-hours')
  peakHours(@CurrentUser() user: AuthedUser, @Query('days') d?: string) {
    return this.analytics.peakHours(user.tenantId as string, days(d));
  }

  @Get('trend')
  trend(@CurrentUser() user: AuthedUser, @Query('days') d?: string) {
    return this.analytics.trend(user.tenantId as string, days(d));
  }

  @Get('alerts')
  alerts(@CurrentUser() user: AuthedUser) {
    return this.analytics.inventoryAlerts(user.tenantId as string);
  }

  /** Force an affinity rebuild instead of waiting for the nightly job. */
  @Roles('VENDOR_OWNER')
  @Post('rebuild-recommendations')
  async rebuild(@CurrentUser() user: AuthedUser) {
    await this.recs.rebuildForTenant(user.tenantId as string);
    return { ok: true };
  }
}

@Controller('storefront')
class StorefrontRecommendationsController {
  constructor(private readonly recs: RecommendationsService) {}

  /**
   * "Goes well with" for the current cart. Edge-cacheable: the answer depends only on
   * the vendor and the set of product ids, not on who is asking.
   */
  @Public()
  @RequireTenant()
  @EdgeCache({ sMaxAge: 300, staleWhileRevalidate: 3600 })
  @Get('recommendations')
  goesWellWith(@CurrentTenant() tenant: RequestTenant, @Query('items') items?: string) {
    const ids = (items ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    return this.recs.goesWellWith(tenant.id, ids);
  }

  /**
   * Past orders for this phone at this vendor. Never edge-cached — it is personal data
   * keyed by a phone number in the query string.
   */
  @Public()
  @RequireTenant()
  @Get('reorder')
  reorder(@CurrentTenant() tenant: RequestTenant, @Query('phone') phone?: string) {
    if (!phone) return [];
    return this.recs.reorderSuggestions(tenant.id, phone);
  }
}

@Controller('marketplace')
@Public()
@PlatformScope('marketplace recommendations read one explicit vendor')
class MarketplaceRecommendationsController {
  constructor(private readonly recs: RecommendationsService) {}

  @EdgeCache({ sMaxAge: 300, staleWhileRevalidate: 3600 })
  @Get('recommendations')
  goesWellWith(
    @Query('tenantId') tenantId: string,
    @Query('items') items?: string,
  ) {
    const ids = (items ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (!tenantId || ids.length === 0) return [];
    return this.recs.goesWellWith(tenantId, ids);
  }
}

@Module({
  controllers: [
    VendorAnalyticsController,
    StorefrontRecommendationsController,
    MarketplaceRecommendationsController,
  ],
  providers: [AnalyticsService, RecommendationsService],
  exports: [AnalyticsService, RecommendationsService],
})
export class AnalyticsModule {}
