import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { configuration } from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { InfraModule } from './infra/infra.module';
import { ObservabilityModule } from './observability/observability.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { MediaModule } from './media/media.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { OrdersModule } from './orders/orders.module';
import { BillingModule } from './billing/billing.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { AssistantModule } from './assistant/assistant.module';
import { RetentionModule } from './retention/retention.module';
import { MarketingModule } from './marketing/marketing.module';
import { OpsModule } from './ops/ops.module';
import { GeoModule } from './geo/geo.module';
import { HealthModule } from './health/health.module';
import { AccessGuard } from './auth/access.guard';
import { RateLimitGuard } from './infra/rate-limit.guard';
import { AllExceptionsFilter } from './common/exception.filter';
import { CacheHeadersInterceptor } from './common/cache-headers.interceptor';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], envFilePath: ['.env', '../../.env'] }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ObservabilityModule,
    InfraModule,
    TenancyModule,
    AuthModule,
    CatalogModule,
    MediaModule,
    MarketplaceModule,
    OrdersModule,
    BillingModule,
    AnalyticsModule,
    LoyaltyModule,
    AssistantModule,
    RetentionModule,
    MarketingModule,
    OpsModule,
    GeoModule,
    HealthModule,
  ],
  providers: [
    // Abuse protection runs BEFORE authentication: a flood of unauthenticated requests
    // must be cheap to reject, not cost a JWT verification and a tenant lookup each.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Authentication, authorisation and tenant-scope binding, on every route by default.
    // Routes opt out explicitly with @Public() — never implicitly.
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_INTERCEPTOR, useClass: CacheHeadersInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
// ContextMiddleware is mounted globally in main.ts rather than through
// `consumer.apply(...).forRoutes('*')`. It must wrap EVERY request — it opens the
// AsyncLocalStorage scope the tenant guard reads — and Express 5's path matching makes
// a module-level wildcard route too easy to get subtly wrong.
