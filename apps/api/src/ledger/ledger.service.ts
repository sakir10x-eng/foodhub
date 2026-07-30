import { Injectable, Logger } from '@nestjs/common';
import { LedgerType } from '@prisma/client';
import { GuardedTx, PrismaService } from '../prisma/prisma.service';

/**
 * The marketplace journal (Mode B money only). OWN_STORE orders never reach this
 * service — that money goes straight from the customer to the vendor's own gateway and
 * we have no claim on it.
 *
 * Two kinds of row live here:
 *
 *   Balance-affecting — VENDOR_PAYABLE (+), REFUND (−), SETTLEMENT (−).
 *     `balanceAfter` is the running total of these, i.e. exactly what we still owe the
 *     vendor. The settlement rollup sums the unsettled ones.
 *
 *   Memo — CUSTOMER_PAYMENT (+total), COMMISSION (−our cut incl. absorbed gateway fee).
 *     Recorded for auditability and revenue reporting; they carry `balanceAfter`
 *     forward unchanged so gross and payable are never conflated.
 */
export const BALANCE_AFFECTING: LedgerType[] = ['VENDOR_PAYABLE', 'REFUND', 'SETTLEMENT'];

type Tx = GuardedTx;

@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Post the entries for a delivered marketplace order.
   *
   * ONE formula covers every payment shape, because they only differ in how much money
   * actually passed through our gateway:
   *
   *     collected = full prepayment  -> the whole total
   *                 50% advance      -> the advance; the rider took the rest in cash
   *                 cash on delivery -> nothing
   *
   *     vendorPayable = collected − commission − gatewayFee
   *
   * That single line reproduces both extremes: a prepaid order leaves us owing the vendor
   * their share, and a cash order goes NEGATIVE — a receivable, because the vendor is
   * holding our commission — with no special-casing. A half-paid order lands where it
   * should, in between.
   *
   * Runs inside the caller's transaction and is guarded by `order.settledAt`, so a
   * replayed DELIVERED webhook cannot pay a vendor twice.
   */
  async postOrderSettlement(
    tx: Tx,
    order: {
      id: string;
      tenantId: string;
      code: string;
      total: number;
      commissionAmount: number;
      gatewayFee: number;
    },
    /** What we actually collected online. */
    collected: number,
  ) {
    const ourCut = order.commissionAmount + order.gatewayFee;
    const vendorPayable = collected - ourCut;
    const cashAtDoor = order.total - collected;
    let balance = await this.currentBalance(tx, order.tenantId);

    // Only a real inflow gets a gross row. A pure cash order has none — nothing reached
    // our gateway — and inventing a ৳0 row would make the statement harder to read.
    if (collected > 0) {
      await tx.ledgerEntry.create({
        data: {
          tenantId: order.tenantId,
          orderId: order.id,
          type: 'CUSTOMER_PAYMENT',
          amount: collected,
          balanceAfter: balance, // memo row — does not move the payable balance
          memo:
            cashAtDoor > 0
              ? `Customer paid ${fmt(collected)} advance for ${order.code} (${fmt(cashAtDoor)} cash on delivery)`
              : `Customer paid for ${order.code}`,
        },
      });
    }

    await tx.ledgerEntry.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        type: 'COMMISSION',
        amount: -ourCut,
        balanceAfter: balance, // memo row
        memo:
          `Platform commission ${fmt(order.commissionAmount)}` +
          (order.gatewayFee ? ` + gateway fee ${fmt(order.gatewayFee)}` : ''),
      },
    });

    balance += vendorPayable;
    await tx.ledgerEntry.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        type: 'VENDOR_PAYABLE',
        amount: vendorPayable,
        balanceAfter: balance,
        memo:
          vendorPayable >= 0
            ? `Payable for ${order.code}`
            : `Commission owed to platform on ${order.code} (cash collected by vendor)`,
      },
    });

    return { vendorPayable, balanceAfter: balance };
  }

  /** Fully prepaid: we hold the whole total. */
  postOrderDelivered(
    tx: Tx,
    order: { id: string; tenantId: string; code: string; total: number; commissionAmount: number; gatewayFee: number },
  ) {
    return this.postOrderSettlement(tx, order, order.total);
  }

  /**
   * Cash-on-delivery on the marketplace: the rider collected everything, so the vendor is
   * holding our commission rather than us holding their payout. The payable goes negative
   * — a receivable — and nets off against their next settlement.
   */
  async postCodCommissionDue(
    tx: Tx,
    order: { id: string; tenantId: string; code: string; commissionAmount: number; gatewayFee: number },
  ) {
    const res = await this.postOrderSettlement(tx, { ...order, total: 0 }, 0);
    return { balanceAfter: res.balanceAfter, due: order.commissionAmount + order.gatewayFee };
  }

  /** Reverse a settled order. Clawed back from the next settlement, never from a paid one. */
  async postRefund(tx: Tx, order: { id: string; tenantId: string; code: string }, amount: number) {
    const balance = (await this.currentBalance(tx, order.tenantId)) - amount;
    await tx.ledgerEntry.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        type: 'REFUND',
        amount: -amount,
        balanceAfter: balance,
        memo: `Refund for ${order.code}`,
      },
    });
    return { balanceAfter: balance };
  }

  /** What we owe this vendor right now, across all unpaid periods. */
  async currentBalance(tx: Tx, tenantId: string): Promise<number> {
    const last = await tx.ledgerEntry.findFirst({
      where: { tenantId, type: { in: BALANCE_AFFECTING } },
      // By `seq`, never `createdAt`: rows written in the same transaction share a
      // timestamp, so ordering by it would pick the "latest" balance at random.
      orderBy: { seq: 'desc' },
      select: { balanceAfter: true },
    });
    return last?.balanceAfter ?? 0;
  }

  /** Unsettled payable — what the next settlement run will pay out. */
  async unsettledPayable(tenantId: string): Promise<number> {
    const agg = await this.prisma.db.ledgerEntry.aggregate({
      where: { tenantId, settlementId: null, type: { in: ['VENDOR_PAYABLE', 'REFUND'] } },
      _sum: { amount: true },
    });
    return agg._sum.amount ?? 0;
  }

  async statement(tenantId: string, opts: { page?: number; pageSize?: number } = {}) {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
    const where = { tenantId };
    const [rows, total] = await Promise.all([
      this.prisma.db.ledgerEntry.findMany({
        where,
        orderBy: { seq: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { order: { select: { code: true, placedAt: true } } },
      }),
      this.prisma.db.ledgerEntry.count({ where }),
    ]);
    return { data: rows, total, page, pageSize };
  }
}

function fmt(poisha: number): string {
  return `৳${(poisha / 100).toFixed(2)}`;
}
