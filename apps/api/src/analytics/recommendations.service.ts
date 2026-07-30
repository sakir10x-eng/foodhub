import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../infra/cache.service';
import { TenantContext } from '../common/tenant-context';
import { toImageRef, IMAGE_SELECT } from '../media/image.mapper';
import { ConfigService } from '@nestjs/config';

/**
 * Recommendations and one-tap reorder.
 *
 * Deliberately not machine learning: on a single restaurant's menu of 10–40 items,
 * co-purchase counts beat an embedding model on both accuracy and explainability, cost
 * one indexed read, and can be debugged by looking at a table. The affinity table is
 * rebuilt nightly; serving is a single query.
 */
@Injectable()
export class RecommendationsService {
  private readonly logger = new Logger(RecommendationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  /** Nightly rebuild of "ordered together" counts for every vendor. */
  @Cron(process.env.AFFINITY_CRON || '30 3 * * *')
  async rebuildAll() {
    const tenants = await TenantContext.runAsPlatform('affinity rebuild spans all vendors', () =>
      this.prisma.readOnly.tenant.findMany({ select: { id: true } }),
    );
    this.logger.log(`Rebuilding product affinities for ${tenants.length} vendor(s)`);
    for (const tenant of tenants) {
      try {
        await this.rebuildForTenant(tenant.id);
      } catch (err) {
        this.logger.error(`Affinity rebuild failed for ${tenant.id}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Recompute one vendor's affinities from the last 180 days of delivered orders.
   *
   * `score` normalises the raw co-count by how often the anchor item sells, so a
   * best-seller doesn't end up recommended next to literally everything.
   */
  async rebuildForTenant(tenantId: string) {
    const since = new Date();
    since.setDate(since.getDate() - 180);

    const pairs = await TenantContext.runAsPlatform('affinity SQL carries its own tenant predicate', () =>
      this.prisma.unsafeRawReplica.$queryRaw<{ a: string; b: string; co: number; a_total: number }[]>`
        WITH item_orders AS (
          SELECT DISTINCT oi."productId" AS product_id, oi."orderId" AS order_id
          FROM "order_items" oi
          JOIN "orders" o ON o.id = oi."orderId"
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o."placedAt" >= ${since}
            AND o.status NOT IN ('CANCELLED', 'REFUNDED')
            AND oi."productId" IS NOT NULL
        ),
        totals AS (
          SELECT product_id, COUNT(*)::int AS n FROM item_orders GROUP BY 1
        )
        SELECT x.product_id AS a,
               y.product_id AS b,
               COUNT(*)::int AS co,
               t.n           AS a_total
        FROM item_orders x
        JOIN item_orders y ON y.order_id = x.order_id AND y.product_id <> x.product_id
        JOIN totals t ON t.product_id = x.product_id
        GROUP BY x.product_id, y.product_id, t.n
        HAVING COUNT(*) >= 2
      `,
    );

    await TenantContext.runAsTenant(tenantId, async () => {
      await this.prisma.db.productAffinity.deleteMany({ where: { tenantId } });
      if (pairs.length === 0) return;
      await this.prisma.db.productAffinity.createMany({
        data: pairs.map((p) => ({
          tenantId,
          productId: p.a,
          relatedId: p.b,
          coCount: p.co,
          score: p.a_total > 0 ? p.co / p.a_total : 0,
        })),
        skipDuplicates: true,
      });
    });

    await this.cache.delByPrefix(`recs:${tenantId}`);
    this.logger.log(`Affinities for ${tenantId}: ${pairs.length} pairs`);
  }

  /**
   * "Goes well with" for the items currently in a cart.
   *
   * Falls back to best-sellers for a new vendor with no order history, because an empty
   * recommendation strip is worse than a generically useful one.
   */
  async goesWellWith(tenantId: string, productIds: string[], limit = 4) {
    if (productIds.length === 0) return [];
    const cacheKey = `recs:${tenantId}:with:${[...productIds].sort().join(',')}:${limit}`;

    return this.cache.wrap(cacheKey, 300, () =>
      TenantContext.runAsTenant(tenantId, async () => {
        const affinities = await this.prisma.readOnly.productAffinity.findMany({
          where: { productId: { in: productIds }, relatedId: { notIn: productIds } },
          orderBy: { score: 'desc' },
          take: limit * 4,
        });

        // Sum scores so an item suggested by two different cart items ranks above one
        // suggested by a single item.
        const ranked = new Map<string, number>();
        for (const a of affinities) {
          ranked.set(a.relatedId, (ranked.get(a.relatedId) ?? 0) + a.score);
        }

        let ids = [...ranked.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id).slice(0, limit);

        if (ids.length < limit) {
          const popular = await this.prisma.readOnly.product.findMany({
            where: { isArchived: false, isAvailable: true, id: { notIn: [...productIds, ...ids] } },
            orderBy: { sortOrder: 'asc' },
            take: limit - ids.length,
            select: { id: true },
          });
          ids = [...ids, ...popular.map((p) => p.id)];
        }
        if (ids.length === 0) return [];

        const products = await this.prisma.readOnly.product.findMany({
          where: { id: { in: ids }, isArchived: false, isAvailable: true },
          select: {
            id: true, name: true, description: true, price: true,
            isAvailable: true, categoryId: true, sortOrder: true,
            image: { select: IMAGE_SELECT },
          },
        });
        const order = new Map(ids.map((id, i) => [id, i]));
        return products
          .sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99))
          .map((p) => ({ ...p, image: toImageRef(p.image, this.config) }));
      }),
    );
  }

  /**
   * One-tap reorder: what this phone has ordered before at this vendor, most recent
   * first, with unavailable items filtered out so the tap always works.
   */
  async reorderSuggestions(tenantId: string, phone: string, limit = 3) {
    const last10 = phone.replace(/\D/g, '').slice(-10);
    if (last10.length < 10) return [];

    return TenantContext.runAsTenant(tenantId, async () => {
      const orders = await this.prisma.readOnly.order.findMany({
        where: { customerPhone: { endsWith: last10 }, status: 'DELIVERED' },
        orderBy: { placedAt: 'desc' },
        take: limit,
        select: {
          id: true, code: true, placedAt: true, total: true,
          items: { select: { productId: true, nameSnapshot: true, priceSnapshot: true, qty: true } },
        },
      });
      if (orders.length === 0) return [];

      const productIds = orders.flatMap((o) => o.items.map((i) => i.productId)).filter(Boolean) as string[];
      const live = await this.prisma.readOnly.product.findMany({
        where: { id: { in: productIds }, isArchived: false },
        select: { id: true, price: true, isAvailable: true, name: true },
      });
      const byId = new Map(live.map((p) => [p.id, p]));

      return orders
        .map((order) => {
          const items = order.items
            .filter((i) => i.productId && byId.has(i.productId))
            .map((i) => {
              const current = byId.get(i.productId!)!;
              return {
                productId: i.productId!,
                // Current name and price, not the snapshot — this is a new order, and
                // showing a stale price would be a broken promise at checkout.
                name: current.name,
                price: current.price,
                qty: i.qty,
                isAvailable: current.isAvailable,
              };
            });
          return {
            fromOrder: order.code,
            placedAt: order.placedAt.toISOString(),
            items,
            total: items.reduce((a, i) => a + i.price * i.qty, 0),
            allAvailable: items.length > 0 && items.every((i) => i.isAvailable),
          };
        })
        .filter((s) => s.items.length > 0);
    });
  }
}
