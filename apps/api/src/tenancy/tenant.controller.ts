import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { addDomainSchema, gatewayConfigSchema, smsConfigSchema, tenantSettingsSchema } from '@foodhub/shared';
import { TenantService } from './tenant.service';
import { TenantResolverService } from './tenant-resolver.service';
import { PlatformRevenueService } from './platform-revenue.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, PlatformScope, Public, RequireTenant, Roles } from '../common/decorators';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

const boolBody = z.object({ value: z.boolean() });

@Controller('vendor')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
export class VendorController {
  constructor(private readonly tenants: TenantService) {}

  @Get('summary')
  summary(@CurrentUser() user: AuthedUser) {
    return this.tenants.summary(user.tenantId as string);
  }

  @Get('settings')
  settings(@CurrentUser() user: AuthedUser) {
    return this.tenants.getOwnSettings(user.tenantId as string);
  }

  @Patch('settings')
  updateSettings(@CurrentUser() user: AuthedUser, @Body(new ZodBody(tenantSettingsSchema)) dto: any) {
    return this.tenants.updateSettings(user.tenantId as string, dto);
  }

  @Post('open')
  setOpen(@CurrentUser() user: AuthedUser, @Body(new ZodBody(boolBody)) dto: { value: boolean }) {
    return this.tenants.setOpen(user.tenantId as string, dto.value);
  }

  /** The Mode B toggle. Owner-only: it changes where the vendor's money comes from. */
  @Roles('VENDOR_OWNER')
  @Post('marketplace-listing')
  setListing(@CurrentUser() user: AuthedUser, @Body(new ZodBody(boolBody)) dto: { value: boolean }) {
    return this.tenants.setMarketplaceListing(user.tenantId as string, dto.value);
  }

  /** Vendor's OWN gateway keys (Mode A). Write-only by design — never read back. */
  @Roles('VENDOR_OWNER')
  @Post('gateway')
  setGateway(@CurrentUser() user: AuthedUser, @Body(new ZodBody(gatewayConfigSchema)) dto: any) {
    return this.tenants.setGatewayConfig(user.tenantId as string, dto);
  }

  /** The vendor's own SMS account, so their texts carry their own sender ID. */
  @Post('sms')
  setSms(@CurrentUser() user: AuthedUser, @Body(new ZodBody(smsConfigSchema)) dto: any) {
    return this.tenants.setSmsConfig(user.tenantId as string, dto);
  }

  @Get('domains')
  domains(@CurrentUser() user: AuthedUser) {
    return this.tenants.listDomains(user.tenantId as string);
  }

  @Roles('VENDOR_OWNER')
  /** Custom domains are the headline Basic feature — gated where the domain is created. */
  @Post('domains')
  addDomain(@CurrentUser() user: AuthedUser, @Body(new ZodBody(addDomainSchema)) dto: { hostname: string }) {
    return this.tenants.addDomain(user.tenantId as string, dto.hostname);
  }

  @Roles('VENDOR_OWNER')
  @Post('domains/:id/primary')
  setPrimary(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.tenants.setPrimaryDomain(user.tenantId as string, id);
  }

  @Roles('VENDOR_OWNER')
  @Delete('domains/:id')
  removeDomain(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.tenants.removeDomain(user.tenantId as string, id);
  }
}

@Controller()
export class PublicTenantController {
  constructor(
    private readonly tenants: TenantService,
    private readonly resolver: TenantResolverService,
  ) {}

  /** Who is this storefront? Resolved from the Host header by ContextMiddleware. */
  @Public()
  @RequireTenant()
  @Get('storefront/tenant')
  storefrontTenant(@CurrentTenant() tenant: RequestTenant) {
    return this.tenants.getPublicTenant(tenant.id);
  }

  /**
   * Caddy's on-demand TLS `ask` hook. Caddy calls this before issuing a certificate for
   * an unknown hostname; a 200 authorises issuance, anything else refuses it. Without
   * this, pointing any DNS record at our edge would make us mint unlimited certificates
   * and hit Let's Encrypt rate limits.
   */
  @Public()
  @PlatformScope('caddy on-demand TLS authorisation')
  @Get('internal/caddy/ask')
  async caddyAsk(@Query('domain') domain: string, @Res() res: Response) {
    const allowed = await this.resolver.isCertificateAllowed(domain ?? '');
    res.status(allowed ? 200 : 403).send(allowed ? 'ok' : 'unknown host');
  }
}

@Controller('platform')
@Roles('PLATFORM_ADMIN')
@PlatformScope('platform admin console')
export class PlatformAdminController {
  constructor(
    private readonly tenants: TenantService,
    private readonly revenue: PlatformRevenueService,
  ) {}

  @Get('overview')
  overview(@Query('days') days?: string) {
    return this.tenants.platformOverview(Math.min(365, Math.max(1, Number(days) || 30)));
  }

  @Get('tenants')
  async list(@Query('q') q?: string) {
    return this.tenants.platformList(q ?? '');
  }

  @Patch('tenants/:id/commission')
  setCommission(
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ bps: z.number().int().min(0).max(5000) }))) dto: { bps: number },
  ) {
    return this.tenants.setCommission(id, dto.bps);
  }

  /** Sell a slot at the top of the marketplace feed. */
  @Post('tenants/:id/promote')
  promote(
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ days: z.number().int().min(1).max(365), rank: z.number().int().min(0).max(1000).default(0) }))) dto: any,
  ) {
    return this.revenue.promote(id, dto.days, dto.rank);
  }

  @Delete('tenants/:id/promote')
  endPromotion(@Param('id') id: string) {
    return this.revenue.endPromotion(id);
  }

  /** The commission rate card, and the job that applies it. */
  @Get('commission-tiers')
  tiers() {
    return this.revenue.listTiers();
  }

  @Put('commission-tiers')
  saveTiers(
    @Body(new ZodBody(z.object({
      tiers: z.array(z.object({
        name: z.string().trim().min(1).max(40),
        minMonthlyGmv: z.number().int().min(0),
        rateBps: z.number().int().min(0).max(5000),
      })).max(10),
    }))) dto: any,
  ) {
    return this.revenue.saveTiers(dto.tiers);
  }

  @Post('commission-tiers/apply')
  applyTiers() {
    return this.revenue.applyTiers();
  }

  @Patch('tenants/:id/plan-status')
  setPlanStatus(
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ status: z.enum(['ACTIVE', 'PAST_DUE', 'SUSPENDED']) })))
    dto: { status: 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' },
  ) {
    return this.tenants.setPlanStatus(id, dto.status);
  }
}
