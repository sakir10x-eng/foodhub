import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import type { SettlementDto } from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

/**
 * Rolls unsettled marketplace payables into a payout per vendor per period.
 *
 * With SSLCommerz split-payout enabled the gateway has already moved the vendor's share,
 * and a settlement row is the reconciliation record. Without split-payout it is the
 * instruction to actually send money — which is also the mode that would require
 * Bangladesh Bank aggregator approval, so it is not the default.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Weekly rollup across every vendor with something owing. */
  @Cron(process.env.SETTLEMENT_CRON || '0 3 * * 1')
  async runScheduled() {
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd);
    periodStart.setDate(periodStart.getDate() - 7);

    const tenantIds = await TenantContext.runAsPlatform('settlement run spans all vendors', () =>
      this.prisma.db.ledgerEntry
        .groupBy({
          by: ['tenantId'],
          where: { settlementId: null, type: { in: ['VENDOR_PAYABLE', 'REFUND'] } },
          _sum: { amount: true },
        })
        .then((rows) => rows.filter((r) => (r._sum.amount ?? 0) !== 0).map((r) => r.tenantId)),
    );

    this.logger.log(`Settlement run: ${tenantIds.length} vendor(s) with a balance`);
    for (const tenantId of tenantIds) {
      try {
        await this.settleTenant(tenantId, periodStart, periodEnd);
      } catch (err) {
        // One vendor's failure must not abort the whole run.
        this.logger.error(`Settlement failed for tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Claims every unsettled entry up to `periodEnd` and writes the payout row.
   *
   * Serializable + the settlementId claim means a concurrent run finds nothing left to
   * claim rather than paying the same balance twice.
   */
  async settleTenant(tenantId: string, periodStart: Date, periodEnd: Date): Promise<SettlementDto | null> {
    return TenantContext.runAsTenant(tenantId, async () => {
      const result = await this.prisma.db.$transaction(
        async (tx) => {
          const unsettled = await tx.ledgerEntry.findMany({
            where: {
              tenantId,
              settlementId: null,
              createdAt: { lte: periodEnd },
              type: { in: ['VENDOR_PAYABLE', 'REFUND'] },
            },
            select: { id: true, amount: true, orderId: true },
          });
          if (unsettled.length === 0) return null;

          const netPayable = unsettled.reduce((acc, e) => acc + e.amount, 0);

          // Gross and commission come from the orders in the period, so the payout
          // statement reconciles against what the vendor sees in their order list.
          const orderIds = [...new Set(unsettled.map((e) => e.orderId).filter(Boolean))] as string[];
          const orderAgg = await tx.order.aggregate({
            where: { id: { in: orderIds } },
            _sum: { total: true, commissionAmount: true, gatewayFee: true },
          });

          const settlement = await tx.settlement.create({
            data: {
              tenantId,
              periodStart,
              periodEnd,
              gross: orderAgg._sum.total ?? 0,
              commission: orderAgg._sum.commissionAmount ?? 0,
              gatewayFees: orderAgg._sum.gatewayFee ?? 0,
              netPayable,
              status: 'PENDING',
            },
          });

          await tx.ledgerEntry.updateMany({
            where: { id: { in: unsettled.map((e) => e.id) } },
            data: { settlementId: settlement.id },
          });
          if (orderIds.length) {
            await tx.order.updateMany({
              where: { id: { in: orderIds } },
              data: { settlementId: settlement.id },
            });
          }

          // Closing entry: the payable balance returns to zero once it is being paid out.
          const last = await tx.ledgerEntry.findFirst({
            where: { tenantId, type: { in: ['VENDOR_PAYABLE', 'REFUND', 'SETTLEMENT'] } },
            orderBy: { seq: 'desc' },
            select: { balanceAfter: true },
          });
          await tx.ledgerEntry.create({
            data: {
              tenantId,
              type: 'SETTLEMENT',
              amount: -netPayable,
              balanceAfter: (last?.balanceAfter ?? 0) - netPayable,
              memo: `Settlement ${settlement.id.slice(0, 8)} for ${unsettled.length} entries`,
              settlementId: settlement.id,
            },
          });

          return settlement;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      if (!result) return null;
      this.logger.log(`Settled ${tenantId}: net ${result.netPayable} poisha`);
      return toSettlementDto(result);
    });
  }

  /** Every vendor's payouts, for the platform console. Newest first. */
  listAll(status?: 'PENDING' | 'PAID') {
    return this.prisma.readOnly.settlement
      .findMany({
        where: status ? { status } : undefined,
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: { tenant: { select: { slug: true, name: true } } },
      })
      .then((rows) =>
        rows.map((s) => ({ ...toSettlementDto(s), tenantSlug: s.tenant.slug, tenantName: s.tenant.name })),
      );
  }

  list(tenantId: string) {
    return this.prisma.db.settlement
      .findMany({ where: { tenantId }, orderBy: { periodEnd: 'desc' }, take: 50 })
      .then((rows) => rows.map(toSettlementDto));
  }

  async getOne(id: string) {
    const settlement = await this.prisma.db.settlement.findUnique({
      where: { id },
      include: {
        orders: { select: { code: true, total: true, commissionAmount: true, placedAt: true } },
        ledgerEntries: true,
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    return settlement;
  }

  /** Platform admin marks a payout as sent. */
  async markPaid(settlementId: string, payoutRef: string) {
    return TenantContext.runAsPlatform('platform admin marks a settlement paid', async () => {
      const settlement = await this.prisma.db.settlement.update({
        where: { id: settlementId },
        data: { status: 'PAID', paidAt: new Date(), payoutRef },
      });
      return toSettlementDto(settlement);
    });
  }
}

function toSettlementDto(s: any): SettlementDto {
  return {
    id: s.id,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    gross: s.gross,
    commission: s.commission,
    netPayable: s.netPayable,
    status: s.status,
    paidAt: s.paidAt?.toISOString() ?? null,
  };
}
