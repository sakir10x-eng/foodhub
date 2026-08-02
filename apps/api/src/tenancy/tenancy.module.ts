import { Global, Module } from '@nestjs/common';
import { TenantResolverService } from './tenant-resolver.service';
import { PlanService } from './plan.service';
import { PlatformRevenueService } from './platform-revenue.service';
import { OpsModule } from '../ops/ops.module';
import { TenantService } from './tenant.service';
import { PlatformAdminController, PublicTenantController, VendorController } from './tenant.controller';
import { ContextMiddleware } from './context.middleware';
import { CryptoService } from '../common/crypto.service';

@Global()
@Module({
  // OpsModule for the hub view on the platform console. No cycle: OpsModule reaches
  // OrdersModule and its children, none of which import TenancyModule.
  imports: [OpsModule],
  controllers: [VendorController, PublicTenantController, PlatformAdminController],
  providers: [TenantResolverService, TenantService, PlanService, PlatformRevenueService, CryptoService, ContextMiddleware],
  exports: [TenantResolverService, TenantService, PlanService, PlatformRevenueService, ContextMiddleware],
})
export class TenancyModule {}
