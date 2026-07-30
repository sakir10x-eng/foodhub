import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

/**
 * The platform's own money: paid placement, commission tiers and co-funded discounts.
 *
 * Everything here is written by a platform admin, never by a vendor — a vendor who could
 * set their own commission rate or promote themselves for free is not a customer, they are
 * an exploit.
 */
@Injectable()
export class PlatformRevenueService {
  private readonly logger = new Logger(PlatformRevenueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* ───────────────────────────────────────────────── paid placement */

  async promote(tenantId: string, days: number, rank: number) {
    if (days < 1 || days > 365) throw new BadRequestException('Promote for between 1 and 365 days');

    const until = new Date();
    until.setDate(until.getDate() + days);

    await TenantContext.runAsPlatform('platform admin sells placement', () =>
      this.prisma.db.tenant.update({
        where: { id: tenantId },
        data: { promotedUntil: until, promotedRank: rank },
      }),
    );
    return { promotedUntil: until, promotedRank: rank };
  }

  async endPromotion(tenantId: string) {
    await TenantContext.runAsPlatform('platform admin ends placement', () =>
      this.prisma.db.tenant.update({
        where: { id: tenantId },
        data: { promotedUntil: null, promotedRank: 0 },
      }),
    );
    return { ok: true };
  }

  /* ──────────────────────────────────────────────── commission tiers */

  listTiers() {
    return TenantContext.runAsPlatform('commission rate card is platform-wide', () =>
      this.prisma.db.commissionTier.findMany({ orderBy: { minMonthlyGmv: 'asc' } }),
    );
  }

  async saveTiers(tiers: { name: string; minMonthlyGmv: number; rateBps: number }[]) {
    // Replaced as a set: a rate card with a gap in it silently drops vendors back to the
    // default rate, and nobody notices until a settlement is wrong.
    await TenantContext.runAsPlatform('commission rate card is platform-wide', () =>
      this.prisma.db.$transaction(async (tx) => {
        await tx.commissionTier.deleteMany({});
        for (const [i, tier] of tiers.entries()) {
          await tx.commissionTier.create({ data: { ...tier, sortOrder: i } });
        }
      }),
    );
    return this.listTiers();
  }

  /**
   * Re-rate every vendor against the tier table, based on last month's marketplace GMV.
   *
   * Applied as a scheduled job rather than per order: a commission rate that moves in the
   * middle of a month makes a settlement impossible to explain to the vendor it is paid to.
   */
  async applyTiers(): Promise<{ moved: number }> {
    const tiers = await this.listTiers();
    if (tiers.length === 0) return { moved: 0 };

    const since = new Date();
    since.setDate(since.getDate() - 30);

    return TenantContext.runAsPlatform('commission re-rating spans every vendor', async () => {
      const gmv = await this.prisma.db.order.groupBy({
        by: ['tenantId'],
        where: { channel: 'MARKETPLACE', placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        _sum: { total: true },
      });

      let moved = 0;
      for (const row of gmv) {
        const monthly = row._sum.total ?? 0;
        // The best tier the vendor qualifies for — tiers are ascending, so the last match wins.
        const tier = [...tiers].reverse().find((t) => monthly >= t.minMonthlyGmv);
        if (!tier) continue;

        const updated = await this.prisma.db.tenant.updateMany({
          where: { id: row.tenantId, commissionRateBps: { not: tier.rateBps } },
          data: { commissionRateBps: tier.rateBps },
        });
        if (updated.count > 0) {
          moved++;
          this.logger.log(`Tenant ${row.tenantId} → ${tier.name} (${tier.rateBps / 100}%)`);
        }
      }
      return { moved };
    });
  }

  /* ─────────────────────────────────────────────── co-funded coupons */

  /**
   * Agree to carry part of a vendor's discount.
   *
   * The budget is the important half: a co-funded code that goes viral is our money
   * leaving at a rate nobody approved, so funding stops the moment the budget is used up
   * and the vendor carries the rest.
   */
  async fundCoupon(tenantId: string, couponId: string, platformShareBps: number, budget: number) {
    if (platformShareBps < 0 || platformShareBps > 10_000) {
      throw new BadRequestException('The platform share must be between 0% and 100%');
    }
    return TenantContext.runAsPlatform('platform admin co-funds a vendor discount', () =>
      this.prisma.db.couponFunding.upsert({
        where: { couponId },
        update: { platformShareBps, budget },
        create: { tenantId, couponId, platformShareBps, budget },
      }),
    );
  }

  /**
   * How much of one discount we carry.
   *
   * Called at checkout. Returns 0 once the budget is exhausted, which is the whole point
   * of having one.
   */
  async platformShareOf(couponId: string | null, discount: number): Promise<number> {
    if (!couponId || discount <= 0) return 0;

    const funding = await TenantContext.runAsPlatform('reading our own funding commitment', () =>
      this.prisma.db.couponFunding.findUnique({ where: { couponId } }),
    );
    if (!funding || funding.platformShareBps === 0) return 0;

    const remaining = Math.max(0, funding.budget - funding.budgetSpent);
    if (remaining === 0) return 0;

    const share = Math.round((discount * funding.platformShareBps) / 10_000);
    return Math.min(share, remaining);
  }

  /** Records what we actually spent, so the budget means something. */
  async recordFundingSpend(couponId: string, amount: number) {
    if (amount <= 0) return;
    await TenantContext.runAsPlatform('recording our own funding spend', () =>
      this.prisma.db.couponFunding.updateMany({
        where: { couponId },
        data: { budgetSpent: { increment: amount } },
      }),
    );
  }
}
