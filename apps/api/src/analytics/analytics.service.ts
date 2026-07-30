import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../infra/cache.service';
import { PlanService } from '../tenancy/plan.service';
import { TenantContext } from '../common/tenant-context';

export interface BestSeller {
  productId: string | null;
  name: string;
  qty: number;
  revenue: number;
  orders: number;
}

export interface HourBucket {
  hour: number;
  orders: number;
  revenue: number;
}

export interface DayPoint {
  date: string;
  orders: number;
  revenue: number;
  ownStore: number;
  marketplace: number;
}

export interface InventoryAlert {
  productId: string;
  name: string;
  reason: 'SOLD_OUT_BUT_SELLING' | 'NEVER_ORDERED' | 'FADING';
  detail: string;
}

/**
 * Vendor analytics.
 *
 * Everything here is a read of the vendor's own data, so it runs against the read
 * replica when one is configured — a 90-day report scan must never compete with order
 * inserts during dinner rush. Results are cached for a few minutes because a dashboard
 * is refreshed far more often than the numbers meaningfully change.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly plans: PlanService,
  ) {}

  /**
   * How far back this vendor may look.
   *
   * Clamped, not refused: asking for a year on the Free plan quietly returns 7 days
   * rather than an error, because the honest answer to "show me last year" from a vendor
   * who has not paid for it is "here is what you have", not a 403 in the middle of a chart.
   */
  private async window(tenantId: string, days: number): Promise<number> {
    return this.plans.clampAnalyticsDays(tenantId, days);
  }

  private since(days: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  async overview(tenantId: string, requestedDays = 30) {
    const days = await this.window(tenantId, requestedDays);
    return this.cache.wrap(`analytics:overview:${tenantId}:${days}`, 180, async () => {
      const since = this.since(days);
      const prev = this.since(days * 2);

      const [current, previous, byChannel] = await Promise.all([
        this.prisma.readOnly.order.aggregate({
          where: { placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
          _count: { _all: true },
          _sum: { total: true, commissionAmount: true },
          _avg: { total: true },
        }),
        this.prisma.readOnly.order.aggregate({
          where: {
            placedAt: { gte: prev, lt: since },
            status: { notIn: ['CANCELLED', 'REFUNDED'] },
          },
          _count: { _all: true },
          _sum: { total: true },
        }),
        this.prisma.readOnly.order.groupBy({
          by: ['channel'],
          where: { placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
          _count: { _all: true },
          _sum: { total: true, commissionAmount: true },
        }),
      ]);

      const revenue = current._sum.total ?? 0;
      const prevRevenue = previous._sum.total ?? 0;

      return {
        days,
        orders: current._count._all,
        revenue,
        averageOrderValue: Math.round(current._avg.total ?? 0),
        commissionPaid: current._sum.commissionAmount ?? 0,
        // Percentage change against the immediately preceding window of equal length,
        // which is the comparison a vendor actually reads the number against.
        revenueChangePct: prevRevenue === 0 ? null : Math.round(((revenue - prevRevenue) / prevRevenue) * 100),
        ordersChangePct:
          previous._count._all === 0
            ? null
            : Math.round(((current._count._all - previous._count._all) / previous._count._all) * 100),
        byChannel: byChannel.map((c) => ({
          channel: c.channel,
          orders: c._count._all,
          revenue: c._sum.total ?? 0,
          commission: c._sum.commissionAmount ?? 0,
        })),
      };
    });
  }

  /** What actually sells. Uses the name snapshot so deleted items still report. */
  async bestSellers(tenantId: string, requestedDays = 30, limit = 10): Promise<BestSeller[]> {
    const days = await this.window(tenantId, requestedDays);
    return this.cache.wrap(`analytics:best:${tenantId}:${days}:${limit}`, 300, () =>
      TenantContext.runAsPlatform('analytics raw SQL carries its own tenant predicate', async () => {
        const since = this.since(days);
        return this.prisma.unsafeRawReplica.$queryRaw<BestSeller[]>`
          SELECT oi."productId"          AS "productId",
                 oi."nameSnapshot"       AS name,
                 SUM(oi.qty)::int        AS qty,
                 SUM(oi.qty * oi."priceSnapshot")::int AS revenue,
                 COUNT(DISTINCT o.id)::int AS orders
          FROM "order_items" oi
          JOIN "orders" o ON o.id = oi."orderId"
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o."placedAt" >= ${since}
            AND o.status NOT IN ('CANCELLED', 'REFUNDED')
          GROUP BY oi."productId", oi."nameSnapshot"
          ORDER BY qty DESC
          LIMIT ${limit}
        `;
      }),
    );
  }

  /**
   * Orders by hour of day, in Asia/Dhaka — a vendor reads this to decide staffing, so
   * it must be their wall clock, not UTC.
   */
  async peakHours(tenantId: string, days = 30): Promise<HourBucket[]> {
    return this.cache.wrap(`analytics:hours:${tenantId}:${days}`, 300, () =>
      TenantContext.runAsPlatform('analytics raw SQL carries its own tenant predicate', async () => {
        const since = this.since(days);
        const rows = await this.prisma.unsafeRawReplica.$queryRaw<
          { hour: number; orders: number; revenue: number }[]
        >`
          SELECT EXTRACT(HOUR FROM o."placedAt" AT TIME ZONE 'Asia/Dhaka')::int AS hour,
                 COUNT(*)::int      AS orders,
                 SUM(o.total)::int  AS revenue
          FROM "orders" o
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o."placedAt" >= ${since}
            AND o.status NOT IN ('CANCELLED', 'REFUNDED')
          GROUP BY 1
          ORDER BY 1
        `;
        // Fill the gaps so the chart has all 24 bars and no misleading axis.
        const byHour = new Map(rows.map((r) => [r.hour, r]));
        return Array.from({ length: 24 }, (_, hour) => byHour.get(hour) ?? { hour, orders: 0, revenue: 0 });
      }),
    );
  }

  /** Daily revenue trend, split by channel so Mode A vs Mode B is visible at a glance. */
  async trend(tenantId: string, requestedDays = 30): Promise<DayPoint[]> {
    const days = await this.window(tenantId, requestedDays);
    return this.cache.wrap(`analytics:trend:${tenantId}:${days}`, 300, () =>
      TenantContext.runAsPlatform('analytics raw SQL carries its own tenant predicate', async () => {
        const since = this.since(days);
        const rows = await this.prisma.unsafeRawReplica.$queryRaw<
          { date: string; orders: number; revenue: number; own_store: number; marketplace: number }[]
        >`
          SELECT to_char(o."placedAt" AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM-DD') AS date,
                 COUNT(*)::int     AS orders,
                 SUM(o.total)::int AS revenue,
                 SUM(CASE WHEN o.channel = 'OWN_STORE'   THEN o.total ELSE 0 END)::int AS own_store,
                 SUM(CASE WHEN o.channel = 'MARKETPLACE' THEN o.total ELSE 0 END)::int AS marketplace
          FROM "orders" o
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o."placedAt" >= ${since}
            AND o.status NOT IN ('CANCELLED', 'REFUNDED')
          GROUP BY 1
          ORDER BY 1
        `;
        return rows.map((r) => ({
          date: r.date,
          orders: r.orders,
          revenue: r.revenue,
          ownStore: r.own_store,
          marketplace: r.marketplace,
        }));
      }),
    );
  }

  /**
   * Things a vendor should act on today.
   *
   * Deliberately a short, specific list rather than a wall of charts — an alert nobody
   * acts on is noise, and the sold-out-but-selling case is the one that actually costs
   * money every hour it goes unnoticed.
   */
  async inventoryAlerts(tenantId: string): Promise<InventoryAlert[]> {
    return TenantContext.runAsTenant(tenantId, async () => {
      const fourteenDaysAgo = this.since(14);
      const alerts: InventoryAlert[] = [];

      const products = await this.prisma.readOnly.product.findMany({
        where: { isArchived: false },
        select: { id: true, name: true, isAvailable: true, createdAt: true },
      });
      if (products.length === 0) return alerts;

      const sales = await TenantContext.runAsPlatform('alert SQL carries its own tenant predicate', () =>
        this.prisma.unsafeRawReplica.$queryRaw<{ productId: string; qty: number; recent: number }[]>`
          SELECT oi."productId" AS "productId",
                 SUM(oi.qty)::int AS qty,
                 SUM(CASE WHEN o."placedAt" >= ${fourteenDaysAgo} THEN oi.qty ELSE 0 END)::int AS recent
          FROM "order_items" oi
          JOIN "orders" o ON o.id = oi."orderId"
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o.status NOT IN ('CANCELLED', 'REFUNDED')
            AND oi."productId" IS NOT NULL
          GROUP BY 1
        `,
      );
      const byProduct = new Map(sales.map((s) => [s.productId, s]));

      for (const product of products) {
        const stat = byProduct.get(product.id);

        // Costing money right now: proven demand, switched off.
        if (!product.isAvailable && (stat?.recent ?? 0) > 0) {
          alerts.push({
            productId: product.id,
            name: product.name,
            reason: 'SOLD_OUT_BUT_SELLING',
            detail: `Marked sold out but sold ${stat!.recent} in the last 14 days`,
          });
          continue;
        }

        // Only flag a never-ordered item once it has had a fair run on the menu.
        const ageDays = (Date.now() - product.createdAt.getTime()) / 86_400_000;
        if (!stat && ageDays > 21) {
          alerts.push({
            productId: product.id,
            name: product.name,
            reason: 'NEVER_ORDERED',
            detail: `On the menu ${Math.round(ageDays)} days with no orders`,
          });
          continue;
        }

        // Sold well historically, nothing recently.
        if (stat && stat.qty >= 10 && stat.recent === 0) {
          alerts.push({
            productId: product.id,
            name: product.name,
            reason: 'FADING',
            detail: `${stat.qty} sold all-time but none in the last 14 days`,
          });
        }
      }

      return alerts.slice(0, 20);
    });
  }
}
