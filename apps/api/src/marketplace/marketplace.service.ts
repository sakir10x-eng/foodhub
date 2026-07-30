import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { PublicTenant } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../infra/cache.service';
import { TenantContext } from '../common/tenant-context';
import { TenantService } from '../tenancy/tenant.service';
import { IMAGE_SELECT, toImageRef } from '../media/image.mapper';
import { buildOffers } from '../catalog/offers';
import { popularProductIds, toApproval, toComboDto } from '../catalog/catalog.service';
import { ReviewsService, toReviewDto } from '../reviews/reviews.service';

export interface NearMeQuery {
  lat?: number;
  lng?: number;
  radiusKm?: number;
  category?: string;
  page?: number;
  pageSize?: number;
}

/**
 * The mother marketplace (Mode B) is a "virtual tenant": it reads across every vendor
 * with listedOnMarketplace = true, but writes orders back to the owning vendor's
 * tenantId. Every read here runs in an explicitly audited platform scope.
 */
@Injectable()
export class MarketplaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly tenants: TenantService,
    private readonly reviews: ReviewsService,
  ) {}

  /** Vendor feed. Edge-cached: this is the marketplace home page. */
  async listVendors(query: NearMeQuery) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, query.pageSize ?? 20));
    const hasGeo = typeof query.lat === 'number' && typeof query.lng === 'number';
    const radiusKm = query.radiusKm ?? this.config.get<number>('marketplace.nearMeRadiusKm') ?? 8;

    const cacheKey = hasGeo
      ? `marketplace:near:${query.lat!.toFixed(2)}:${query.lng!.toFixed(2)}:${radiusKm}:${page}:${pageSize}`
      : `marketplace:vendors:${page}:${pageSize}`;

    return this.cache.wrap(cacheKey, 60, async () =>
      TenantContext.runAsPlatform('marketplace vendor feed spans all listed tenants', async () => {
        if (hasGeo) return this.nearMe(query.lat!, query.lng!, radiusKm, page, pageSize);

        const where: Prisma.TenantWhereInput = { listedOnMarketplace: true, planStatus: { not: 'SUSPENDED' } };
        const [rows, total] = await Promise.all([
          this.prisma.db.tenant.findMany({
            where,
            include: { logo: { select: IMAGE_SELECT }, cover: { select: IMAGE_SELECT } },
            /*
             * Open kitchens first — a closed restaurant at the top of the feed is a dead
             * click. Paid placement sorts WITHIN that, never above it: selling a slot that
             * sends customers to a shut kitchen burns the vendor's money and the feed's
             * credibility at the same time, and the feed is what earns the commission.
             */
            orderBy: [
              { isOpen: 'desc' },
              { promotedUntil: { sort: 'desc', nulls: 'last' } },
              { promotedRank: 'desc' },
              { createdAt: 'desc' },
            ],
            skip: (page - 1) * pageSize,
            take: pageSize,
          }),
          this.prisma.db.tenant.count({ where }),
        ]);
        const now = new Date();
        return {
          data: rows.map((t) => ({
            ...this.tenants.toPublic(t),
            // Labelled, always. An unmarked paid slot is the fastest way to teach
            // customers that the ranking cannot be trusted.
            promoted: Boolean(t.promotedUntil && t.promotedUntil > now),
          })),
          total,
          page,
          pageSize,
        };
      }),
    );
  }

  /**
   * "Near me" without PostGIS: a bounding box narrows the candidate set using the
   * (lat, lng) index, then the haversine expression sorts what survives. Good to a few
   * thousand vendors per city, which is well past where we need to care.
   */
  private async nearMe(lat: number, lng: number, radiusKm: number, page: number, pageSize: number) {
    const latDelta = radiusKm / 111.0;
    const lngDelta = radiusKm / (111.0 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));

    const rows = await this.prisma.unsafeRaw.$queryRaw<{ id: string; distance_km: number }[]>`
      SELECT id,
             6371 * acos(
               LEAST(1, GREATEST(-1,
                 cos(radians(${lat})) * cos(radians("lat")) *
                 cos(radians("lng") - radians(${lng})) +
                 sin(radians(${lat})) * sin(radians("lat"))
               ))
             ) AS distance_km
      FROM "tenants"
      WHERE "listedOnMarketplace" = true
        AND "planStatus" <> 'SUSPENDED'
        AND "lat" IS NOT NULL AND "lng" IS NOT NULL
        AND "lat" BETWEEN ${lat - latDelta} AND ${lat + latDelta}
        AND "lng" BETWEEN ${lng - lngDelta} AND ${lng + lngDelta}
      ORDER BY distance_km ASC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}
    `;

    if (rows.length === 0) return { data: [], total: 0, page, pageSize };

    const ids = rows.map((r) => r.id);
    const tenants = await this.prisma.db.tenant.findMany({
      where: { id: { in: ids } },
      include: { logo: { select: IMAGE_SELECT }, cover: { select: IMAGE_SELECT } },
    });
    const byId = new Map(tenants.map((t) => [t.id, t]));

    const data: PublicTenant[] = [];
    for (const row of rows) {
      const tenant = byId.get(row.id);
      if (!tenant) continue;
      data.push({ ...this.tenants.toPublic(tenant), distanceKm: Math.round(row.distance_km * 10) / 10 });
    }

    return { data, total: data.length, page, pageSize };
  }

  /** A single vendor's marketplace storefront, filtered to items they chose to list. */
  async getVendorMenu(slug: string) {
    return TenantContext.runAsPlatform('marketplace vendor page reads one tenant by slug', async () => {
      const tenant = await this.prisma.db.tenant.findUnique({
        where: { slug },
        include: { logo: { select: IMAGE_SELECT }, cover: { select: IMAGE_SELECT } },
      });
      if (!tenant || !tenant.listedOnMarketplace || tenant.planStatus === 'SUSPENDED') {
        throw new NotFoundException('Restaurant not found');
      }

      const [categories, products, combos, coupons, reviews] = await Promise.all([
        this.prisma.db.category.findMany({ where: { tenantId: tenant.id }, orderBy: { sortOrder: 'asc' } }),
        this.prisma.db.product.findMany({
          // Both flags must be true: the tenant-level switch AND the per-item override.
          where: { tenantId: tenant.id, isArchived: false, listedOnMarketplace: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true, categoryId: true, name: true, description: true, price: true,
            compareAtPrice: true, thumbsUp: true, thumbsTotal: true,
            isAvailable: true, sortOrder: true, image: { select: IMAGE_SELECT },
            modifierGroups: {
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true, name: true, minSelect: true, maxSelect: true,
                options: {
                  where: { isAvailable: true },
                  orderBy: { sortOrder: 'asc' },
                  select: { id: true, name: true, priceDelta: true },
                },
              },
            },
          },
        }),
        this.prisma.db.combo.findMany({
          where: { tenantId: tenant.id, isAvailable: true, listedOnMarketplace: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            image: { select: IMAGE_SELECT },
            items: { include: { product: { select: { id: true, name: true, price: true } } } },
          },
        }),
        this.prisma.db.coupon.findMany({
          where: {
            tenantId: tenant.id,
            isActive: true,
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        this.reviews.recent(tenant.id),
      ]);

      const popular = await popularProductIds(this.prisma, this.cache, tenant.id);
      const mapped = products.map(({ thumbsUp, thumbsTotal, ...p }) => ({
        ...p,
        image: toImageRef(p.image, this.config),
        popular: popular.has(p.id),
        approval: toApproval(thumbsUp, thumbsTotal),
        modifierGroups: (p as any).modifierGroups.filter((g: any) => g.options.length > 0),
      }));
      const grouped = categories
        .map((c) => ({
          id: c.id,
          name: c.name,
          sortOrder: c.sortOrder,
          products: mapped.filter((p) => p.categoryId === c.id),
        }))
        .filter((c) => c.products.length > 0);

      const orphans = mapped.filter((p) => !p.categoryId || !categories.some((c) => c.id === p.categoryId));
      if (orphans.length) grouped.push({ id: 'other', name: 'Other', sortOrder: 9999, products: orphans });

      return {
        tenant: this.tenants.toPublic(tenant),
        categories: grouped,
        offers: buildOffers(tenant, coupons),
        combos: combos.map((c) => toComboDto(c, this.config)),
        reviews: reviews.map(toReviewDto),
        version: String(tenant.menuVersion),
      };
    });
  }

  /**
   * Instant, typo-tolerant search over dishes and restaurants.
   *
   * pg_trgm similarity handles "birani" -> "Biryani" and is fast enough well past our
   * first-year volume. When it stops being fast, only this method changes — swap the two
   * queries for a Meilisearch/Typesense call and the API contract stays identical.
   */
  async search(term: string, limit = 20) {
    const q = term.trim();
    if (q.length < 2) return { dishes: [], vendors: [] };

    const cacheKey = `marketplace:search:${q.toLowerCase()}:${limit}`;
    return this.cache.wrap(cacheKey, 30, () =>
      TenantContext.runAsPlatform('marketplace search spans all listed tenants', async () => {
        const [dishes, vendors] = await Promise.all([
          // word_similarity, not similarity: a short query against a long dish name
          // ("birani" vs "Chicken Biryani") scores far below the 0.3 similarity()
          // threshold because the whole string is compared. word_similarity scores the
          // query against the best-matching run of words instead, which is what a
          // shopper actually means when they type three letters.
          this.prisma.unsafeRaw.$queryRaw<DishHit[]>`
            SELECT p."id", p."name", p."price", p."isAvailable",
                   t."slug" AS tenant_slug, t."name" AS tenant_name, t."isOpen" AS tenant_open,
                   i."key" AS image_key, i."blurhash" AS image_blurhash,
                   GREATEST(
                     word_similarity(${q}, p."name"),
                     word_similarity(${q}, p."description") * 0.6
                   ) AS score
            FROM "products" p
            JOIN "tenants" t ON t."id" = p."tenantId"
            LEFT JOIN "images" i ON i."id" = p."imageId"
            WHERE p."isArchived" = false
              AND p."listedOnMarketplace" = true
              AND t."listedOnMarketplace" = true
              AND t."planStatus" <> 'SUSPENDED'
              AND (
                word_similarity(${q}, p."name") >= 0.4
                OR word_similarity(${q}, p."description") >= 0.6
                OR p."name" ILIKE ${'%' + q + '%'}
              )
            ORDER BY score DESC, p."isAvailable" DESC
            LIMIT ${limit}
          `,
          this.prisma.unsafeRaw.$queryRaw<VendorHit[]>`
            SELECT t."id", t."slug", t."name", t."isOpen", t."tagline",
                   i."key" AS image_key, i."blurhash" AS image_blurhash,
                   word_similarity(${q}, t."name") AS score
            FROM "tenants" t
            LEFT JOIN "images" i ON i."id" = t."logoId"
            WHERE t."listedOnMarketplace" = true
              AND t."planStatus" <> 'SUSPENDED'
              AND (word_similarity(${q}, t."name") >= 0.4 OR t."name" ILIKE ${'%' + q + '%'})
            ORDER BY score DESC
            LIMIT 8
          `,
        ]);

        const base = (this.config.get<string>('media.cdnBase') || this.config.get<string>('media.publicBase') || '/media').replace(/\/$/, '');
        return {
          dishes: dishes.map((d) => ({
            id: d.id,
            name: d.name,
            price: d.price,
            isAvailable: d.isAvailable,
            vendorSlug: d.tenant_slug,
            vendorName: d.tenant_name,
            vendorOpen: d.tenant_open,
            image: d.image_key ? { url: `${base}/${d.image_key}`, blurhash: d.image_blurhash } : null,
          })),
          vendors: vendors.map((v) => ({
            id: v.id,
            slug: v.slug,
            name: v.name,
            tagline: v.tagline,
            isOpen: v.isOpen,
            image: v.image_key ? { url: `${base}/${v.image_key}`, blurhash: v.image_blurhash } : null,
          })),
        };
      }),
    );
  }
}

interface DishHit {
  id: string;
  name: string;
  price: number;
  isAvailable: boolean;
  tenant_slug: string;
  tenant_name: string;
  tenant_open: boolean;
  image_key: string | null;
  image_blurhash: string | null;
  score: number;
}

interface VendorHit {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  isOpen: boolean;
  image_key: string | null;
  image_blurhash: string | null;
  score: number;
}
