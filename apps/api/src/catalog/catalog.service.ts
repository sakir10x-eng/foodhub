import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ProductInput, PublicCategory, PublicMenu, PublicProduct } from '@foodhub/shared';
import { buildOffers } from './offers';
import { ReviewsService, toReviewDto } from '../reviews/reviews.service';
import { PlanService } from '../tenancy/plan.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../infra/cache.service';
import { TenantContext } from '../common/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import { IMAGE_SELECT, toImageRef } from '../media/image.mapper';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * The handful of dishes a storefront is allowed to call "Popular".
 *
 * Earned, never set: the top three sellers of the last 30 days, and only those with
 * enough behind them to mean something. A badge a vendor can switch on for every item is
 * a badge customers stop reading, and a badge on a dish two people ever ordered is a lie
 * with a number behind it.
 *
 * Replica-routed and cached for five minutes, and it rides inside the already-cached menu
 * payload — so a storefront pays for it once per menu version at most. If it fails for
 * any reason the menu still renders, just without badges.
 *
 * Shared by both channels so a dish cannot be popular on the vendor's own site and
 * ordinary on the marketplace.
 */
export async function popularProductIds(
  prisma: PrismaService,
  cache: CacheService,
  tenantId: string,
): Promise<Set<string>> {
  const MIN_SOLD = 3;
  try {
    const rows = await cache.wrap(`menu:popular:${tenantId}`, 300, () =>
      TenantContext.runAsPlatform('best-seller raw SQL carries its own tenant predicate', () =>
        prisma.unsafeRawReplica.$queryRaw<{ productId: string | null }[]>`
          SELECT oi."productId" AS "productId"
          FROM "order_items" oi
          JOIN "orders" o ON o.id = oi."orderId"
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o."placedAt" >= NOW() - INTERVAL '30 days'
            AND o.status NOT IN ('CANCELLED', 'REFUNDED')
            AND oi."productId" IS NOT NULL
          GROUP BY oi."productId"
          HAVING SUM(oi.qty) >= ${MIN_SOLD}
          ORDER BY SUM(oi.qty) DESC
          LIMIT 3
        `,
      ),
    );
    return new Set(rows.map((r) => r.productId).filter((id): id is string => !!id));
  } catch {
    // A menu that renders without badges beats a storefront that 500s over a garnish.
    return new Set();
  }
}

/**
 * How many people have to have voted on a dish before the number goes on the menu.
 *
 * "100% (1)" reads like a score and carries none of one — and on a new store it would sit
 * next to a dish nobody has an opinion about yet. Five is where the number starts saying
 * something a customer can act on.
 */
export const MIN_DISH_VOTES = 5;

/** The public shape of a dish's approval, or nothing when too few people have voted. */
export function toApproval(up: number, total: number): { percent: number; count: number } | undefined {
  if (!total || total < MIN_DISH_VOTES) return undefined;
  return { percent: Math.round((up / total) * 100), count: total };
}

const PRODUCT_SELECT = {
  id: true,
  categoryId: true,
  name: true,
  description: true,
  price: true,
  compareAtPrice: true,
  thumbsUp: true,
  thumbsTotal: true,
  isAvailable: true,
  listedOnMarketplace: true,
  sortOrder: true,
  image: { select: IMAGE_SELECT },
  // Modifier groups ride along with the menu: the storefront needs them the moment the
  // customer taps an item, and a second round-trip there is a visible stutter.
  modifierGroups: {
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      minSelect: true,
      maxSelect: true,
      options: {
        where: { isAvailable: true },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, priceDelta: true },
      },
    },
  },
} as const;

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly tenants: TenantService,
    private readonly realtime: RealtimeGateway,
    private readonly reviews: ReviewsService,
    private readonly plans: PlanService,
  ) {}

  /* ───────────────────────────────────────────────── vendor-side writes */

  listCategories() {
    return this.prisma.db.category.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { _count: { select: { products: true } } },
    });
  }

  async createCategory(tenantId: string, input: { name: string; sortOrder?: number }) {
    // tenantId is passed explicitly as well as injected by the tenant guard — the guard
    // is the safety net, not the mechanism.
    const category = await this.prisma.db.category.create({
      data: { tenantId, name: input.name, sortOrder: input.sortOrder ?? 0 },
    });
    await this.bumpMenu(tenantId);
    return category;
  }

  async updateCategory(tenantId: string, id: string, input: { name?: string; sortOrder?: number }) {
    const category = await this.prisma.db.category.update({ where: { id }, data: input });
    await this.bumpMenu(tenantId);
    return category;
  }

  async deleteCategory(tenantId: string, id: string) {
    // Products survive their category (they just fall into "Other") — deleting a
    // category must never silently delete a vendor's menu.
    await this.prisma.db.product.updateMany({ where: { categoryId: id }, data: { categoryId: null } });
    await this.prisma.db.category.delete({ where: { id } });
    await this.bumpMenu(tenantId);
    return { ok: true };
  }

  listProducts(opts: { includeArchived?: boolean } = {}) {
    return this.prisma.db.product
      .findMany({
        where: opts.includeArchived ? undefined : { isArchived: false },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { ...PRODUCT_SELECT, isArchived: true, createdAt: true },
      })
      .then((rows) =>
        rows.map((p) => ({ ...p, image: toImageRef(p.image, this.config) })),
      );
  }

  async createProduct(tenantId: string, input: ProductInput) {
    // The Free plan's item cap. Checked on create only — an existing menu is never
    // truncated by a downgrade, because deleting a vendor's food to enforce billing is
    // not a thing we do.
    await this.plans.assertMenuRoom(tenantId);

    await this.assertCategoryOwned(input.categoryId);
    const product = await this.prisma.db.product.create({
      data: {
        tenantId,
        categoryId: input.categoryId ?? null,
        name: input.name,
        description: input.description ?? '',
        price: input.price,
        compareAtPrice: input.compareAtPrice ?? null,
        imageId: input.imageId ?? null,
        isAvailable: input.isAvailable ?? true,
        listedOnMarketplace: input.listedOnMarketplace ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
      select: PRODUCT_SELECT,
    });
    await this.bumpMenu(tenantId);
    return { ...product, image: toImageRef(product.image, this.config) };
  }

  async updateProduct(tenantId: string, id: string, input: Partial<ProductInput>) {
    if (input.categoryId) await this.assertCategoryOwned(input.categoryId);
    const product = await this.prisma.db.product.update({
      where: { id },
      data: {
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.price !== undefined ? { price: input.price } : {}),
        ...(input.compareAtPrice !== undefined ? { compareAtPrice: input.compareAtPrice } : {}),
        ...(input.imageId !== undefined ? { imageId: input.imageId } : {}),
        ...(input.isAvailable !== undefined ? { isAvailable: input.isAvailable } : {}),
        ...(input.listedOnMarketplace !== undefined ? { listedOnMarketplace: input.listedOnMarketplace } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      },
      select: PRODUCT_SELECT,
    });
    await this.bumpMenu(tenantId);
    return { ...product, image: toImageRef(product.image, this.config) };
  }

  /**
   * Availability is the one menu field that changes minute to minute ("we're out of
   * chicken"). It patches the cached menu rather than invalidating it, so flipping a
   * sold-out toggle during dinner rush doesn't cold-start every storefront render.
   */
  async setAvailability(tenantId: string, id: string, isAvailable: boolean) {
    await this.prisma.db.product.update({ where: { id }, data: { isAvailable } });
    await this.patchCachedAvailability(tenantId, id, isAvailable);
    // Anyone with the menu open sees the item grey out immediately, rather than
    // discovering it at checkout.
    this.realtime.emitAvailability(tenantId, id, isAvailable);
    return { id, isAvailable };
  }

  async archiveProduct(tenantId: string, id: string) {
    // Archive, never delete: order history snapshots reference the product row.
    await this.prisma.db.product.update({ where: { id }, data: { isArchived: true, isAvailable: false } });
    await this.bumpMenu(tenantId);
    return { ok: true };
  }

  async reorderProducts(tenantId: string, order: { id: string; sortOrder: number }[]) {
    if (order.length > 500) throw new BadRequestException('Too many items in one reorder');
    await this.prisma.db.$transaction(
      order.map((o) => this.prisma.db.product.update({ where: { id: o.id }, data: { sortOrder: o.sortOrder } })),
    );
    await this.bumpMenu(tenantId);
    return { ok: true };
  }

  private async assertCategoryOwned(categoryId: string | null | undefined) {
    if (!categoryId) return;
    // Guarded model: this findUnique is already pinned to the caller's tenant, so a
    // category id borrowed from another vendor simply comes back null.
    const category = await this.prisma.db.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    });
    if (!category) throw new NotFoundException('Category not found');
  }

  /* ─────────────────────────────────────────────────── public menu read */

  /**
   * The storefront's hot path. Menus change rarely, so this is cached hard and keyed by
   * the tenant's menuVersion — a menu edit bumps the version, which makes every old key
   * unreachable rather than requiring a cache sweep.
   */
  async getPublicMenu(tenantId: string): Promise<PublicMenu> {
    const version = await this.menuVersion(tenantId);
    const key = `menu:${tenantId}:v${version}`;
    const ttl = this.config.get<number>('cache.menuTtlSeconds') ?? 300;

    return this.cache.wrap(key, ttl, async () => {
      const popular = await popularProductIds(this.prisma, this.cache, tenantId);
      const [tenant, categories, products, combos, coupons, reviews] = await TenantContext.runAsPlatform(
        'public menu read for one explicit tenant',
        () =>
          Promise.all([
            this.prisma.db.tenant.findUnique({
              where: { id: tenantId },
              include: { logo: { select: IMAGE_SELECT }, cover: { select: IMAGE_SELECT } },
            }),
            this.prisma.db.category.findMany({ where: { tenantId }, orderBy: { sortOrder: 'asc' } }),
            this.prisma.db.product.findMany({
              where: { tenantId, isArchived: false },
              orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
              select: PRODUCT_SELECT,
            }),
            this.prisma.db.combo.findMany({
              where: { tenantId, isAvailable: true },
              orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
              include: {
                image: { select: IMAGE_SELECT },
                items: { include: { product: { select: { id: true, name: true, price: true } } } },
              },
            }),
            this.prisma.db.coupon.findMany({
              where: {
                tenantId,
                isActive: true,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
              orderBy: { createdAt: 'desc' },
              take: 10,
            }),
            this.reviews.recent(tenantId),
          ]),
      );

      if (!tenant) throw new NotFoundException('Store not found');

      const mapped: PublicProduct[] = products.map((p) => ({
        id: p.id,
        categoryId: p.categoryId,
        name: p.name,
        description: p.description,
        price: p.price,
        compareAtPrice: p.compareAtPrice,
        image: toImageRef(p.image, this.config),
        isAvailable: p.isAvailable,
        sortOrder: p.sortOrder,
        popular: popular.has(p.id),
        approval: toApproval(p.thumbsUp, p.thumbsTotal),
        // Groups whose options have all sold out are dropped rather than shown empty —
        // a required choice with nothing to choose blocks the add-to-cart button.
        modifierGroups: (p as any).modifierGroups
          .filter((g: any) => g.options.length > 0)
          .map((g: any) => ({
            id: g.id, name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect,
            options: g.options,
          })),
      }));

      const grouped: PublicCategory[] = categories.map((c) => ({
        id: c.id,
        name: c.name,
        sortOrder: c.sortOrder,
        products: mapped.filter((p) => p.categoryId === c.id),
      }));

      const orphans = mapped.filter((p) => !p.categoryId || !categories.some((c) => c.id === p.categoryId));
      if (orphans.length) {
        grouped.push({ id: 'other', name: 'Other', sortOrder: 9999, products: orphans });
      }

      return {
        tenant: this.tenants.toPublic(tenant),
        categories: grouped.filter((c) => c.products.length > 0),
        offers: buildOffers(tenant, coupons),
        combos: combos.map((c) => toComboDto(c, this.config)),
        reviews: reviews.map(toReviewDto),
        version: String(version),
      };
    });
  }

  private async menuVersion(tenantId: string): Promise<number> {
    const key = `menuver:${tenantId}`;
    const cached = await this.cache.get<number>(key);
    if (cached) return cached;
    const tenant = await TenantContext.runAsPlatform('read menu version', () =>
      this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { menuVersion: true } }),
    );
    const version = tenant?.menuVersion ?? 1;
    await this.cache.set(key, version, 60);
    return version;
  }

  /** Public alias — modifier and combo edits change the menu too. */
  bumpMenuVersion(tenantId: string) {
    return this.bumpMenu(tenantId);
  }

  private async bumpMenu(tenantId: string) {
    const tenant = await TenantContext.runAsPlatform('bump menu version after a catalog write', () =>
      this.prisma.db.tenant.update({
        where: { id: tenantId },
        data: { menuVersion: { increment: 1 } },
        select: { menuVersion: true },
      }),
    );
    await this.cache.set(`menuver:${tenantId}`, tenant.menuVersion, 60);
    await this.cache.delByPrefix('marketplace:');
  }

  /** Surgical cache edit so a sold-out toggle costs one small write, not a menu rebuild. */
  private async patchCachedAvailability(tenantId: string, productId: string, isAvailable: boolean) {
    const version = await this.menuVersion(tenantId);
    const key = `menu:${tenantId}:v${version}`;
    const menu = await this.cache.get<PublicMenu>(key);
    if (!menu) return;
    let touched = false;
    for (const category of menu.categories) {
      for (const product of category.products) {
        if (product.id === productId) {
          product.isAvailable = isAvailable;
          touched = true;
        }
      }
    }
    if (touched) {
      const ttl = this.config.get<number>('cache.menuTtlSeconds') ?? 300;
      await this.cache.set(key, menu, ttl);
    }
    await this.cache.delByPrefix('marketplace:');
  }
}

/** Combos travel with their parts so the storefront can show what is inside the bundle. */
export function toComboDto(combo: any, config: any) {
  const partsTotal = combo.items.reduce(
    (a: number, i: any) => a + (i.product?.price ?? 0) * i.qty,
    0,
  );
  return {
    id: combo.id,
    name: combo.name,
    description: combo.description,
    price: combo.price,
    image: toImageRef(combo.image, config),
    // What the same items would cost bought separately. Shown struck through, and only
    // when the bundle is genuinely cheaper — a "saving" of ৳0 insults the reader.
    partsTotal,
    saving: Math.max(0, partsTotal - combo.price),
    items: combo.items.map((i: any) => ({
      productId: i.productId,
      name: i.product?.name ?? '',
      qty: i.qty,
    })),
  };
}
