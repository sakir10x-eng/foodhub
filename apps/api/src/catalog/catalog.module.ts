import { Body, Controller, Delete, Get, Module, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { categorySchema, comboSchema, modifierGroupSchema, productPatchSchema, productSchema } from '@foodhub/shared';
import { ReviewsModule } from '../reviews/reviews.module';
import { ModifiersService } from './modifiers.service';
import { CatalogService } from './catalog.service';
import { ZodBody } from '../common/zod.pipe';
import { CurrentTenant, CurrentUser, Public, RequireTenant, Roles } from '../common/decorators';
import { EdgeCache } from '../common/cache-headers.interceptor';
import type { AuthedUser } from '../common/decorators';
import type { RequestTenant } from '../common/request-types';

const availabilitySchema = z.object({ isAvailable: z.boolean() });
const reorderSchema = z.object({
  order: z.array(z.object({ id: z.string().uuid(), sortOrder: z.number().int().min(0).max(9999) })).max(500),
});

@Controller('vendor/menu')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
class VendorMenuController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  categories() {
    return this.catalog.listCategories();
  }

  @Post('categories')
  createCategory(@CurrentUser() user: AuthedUser, @Body(new ZodBody(categorySchema)) dto: any) {
    return this.catalog.createCategory(user.tenantId as string, dto);
  }

  @Patch('categories/:id')
  updateCategory(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(categorySchema.partial())) dto: any,
  ) {
    return this.catalog.updateCategory(user.tenantId as string, id, dto);
  }

  @Delete('categories/:id')
  deleteCategory(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.catalog.deleteCategory(user.tenantId as string, id);
  }

  @Get('products')
  products(@Query('archived') archived?: string) {
    return this.catalog.listProducts({ includeArchived: archived === '1' });
  }

  @Post('products')
  createProduct(@CurrentUser() user: AuthedUser, @Body(new ZodBody(productSchema)) dto: any) {
    return this.catalog.createProduct(user.tenantId as string, dto);
  }

  @Patch('products/:id')
  updateProduct(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(productPatchSchema)) dto: any,
  ) {
    return this.catalog.updateProduct(user.tenantId as string, id, dto);
  }

  /** Hot path during service — kept separate from the full update so it stays cheap. */
  @Post('products/:id/availability')
  setAvailability(
    @CurrentUser() user: AuthedUser,
    @Param('id') id: string,
    @Body(new ZodBody(availabilitySchema)) dto: { isAvailable: boolean },
  ) {
    return this.catalog.setAvailability(user.tenantId as string, id, dto.isAvailable);
  }

  @Post('products/reorder')
  reorder(@CurrentUser() user: AuthedUser, @Body(new ZodBody(reorderSchema)) dto: any) {
    return this.catalog.reorderProducts(user.tenantId as string, dto.order);
  }

  @Delete('products/:id')
  archive(@CurrentUser() user: AuthedUser, @Param('id') id: string) {
    return this.catalog.archiveProduct(user.tenantId as string, id);
  }
}

@Controller('vendor/menu')
@Roles('VENDOR_OWNER', 'VENDOR_STAFF')
@RequireTenant()
class VendorModifiersController {
  constructor(
    private readonly modifiers: ModifiersService,
    private readonly catalog: CatalogService,
  ) {}

  @Get('products/:id/modifiers')
  groups(@Param('id') id: string) {
    return this.modifiers.listForProduct(id);
  }

  /** Replaces the whole set — see the note on ModifiersService.replaceGroups. */
  @Put('products/:id/modifiers')
  async setGroups(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body(new ZodBody(z.object({ groups: z.array(modifierGroupSchema).max(10) }))) dto: any,
  ) {
    const groups = await this.modifiers.replaceGroups(tenant.id, id, dto.groups);
    await this.catalog.bumpMenuVersion(tenant.id);
    return groups;
  }

  @Get('combos')
  combos() {
    return this.modifiers.listCombos();
  }

  @Post('combos')
  async createCombo(
    @CurrentTenant() tenant: RequestTenant,
    @Body(new ZodBody(comboSchema)) dto: any,
  ) {
    const combo = await this.modifiers.createCombo(tenant.id, dto);
    await this.catalog.bumpMenuVersion(tenant.id);
    return combo;
  }

  @Put('combos/:id')
  async updateCombo(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body(new ZodBody(comboSchema)) dto: any,
  ) {
    const combo = await this.modifiers.updateCombo(tenant.id, id, dto);
    await this.catalog.bumpMenuVersion(tenant.id);
    return combo;
  }

  @Delete('combos/:id')
  async deleteCombo(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    const res = await this.modifiers.deleteCombo(id);
    await this.catalog.bumpMenuVersion(tenant.id);
    return res;
  }
}

@Controller('storefront')
class StorefrontController {
  constructor(private readonly catalog: CatalogService) {}

  /** The single call a storefront needs to render. Cached hard; see CatalogService. */
  @Public()
  @RequireTenant()
  // The menu is the hot path and changes rarely. stale-while-revalidate means a cache
  // expiry refreshes in the background instead of stalling a customer mid-scroll.
  @EdgeCache({ sMaxAge: 60, staleWhileRevalidate: 600 })
  @Get('menu')
  menu(@CurrentTenant() tenant: RequestTenant) {
    return this.catalog.getPublicMenu(tenant.id);
  }
}

@Module({
  imports: [ReviewsModule],
  controllers: [VendorMenuController, VendorModifiersController, StorefrontController],
  providers: [CatalogService, ModifiersService],
  exports: [CatalogService, ModifiersService],
})
export class CatalogModule {}
