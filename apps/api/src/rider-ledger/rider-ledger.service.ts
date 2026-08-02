import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { RiderAccount, RiderLedgerType } from '@prisma/client';
import { GuardedTx, PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

/** What a rider's two books say right now. Poisha. */
export interface RiderBalances {
  /** The shop's money in the rider's pocket. Should reach zero every evening. */
  cash: number;
  /** Ours, owed to them. */
  earnings: number;
}

/**
 * A rider's money.
 *
 * Two books, never one — see the `RiderAccount` comment in the schema. Everything here is
 * integer poisha, and every balance is derived by ordering on `seq`, never on `createdAt`:
 * Postgres `now()` is transaction-scoped, so rows written in one transaction share a
 * timestamp and "the latest one" becomes a coin toss. The vendor ledger double-counted a
 * payable that way once; this one is built with the lesson already applied.
 */
@Injectable()
export class RiderLedgerService {
  private readonly logger = new Logger(RiderLedgerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Append one entry and carry the running balance forward.
   *
   * Returns null when an entry of this kind already exists for this order — which is not
   * an error but the point: DELIVERED can fire twice (a retried webhook, a double tap),
   * and the second one must not pay the rider again or add cash they never took. The
   * unique index on `(orderId, type)` is the guarantee; this catch is how it stays quiet.
   */
  async post(
    tx: GuardedTx,
    input: {
      riderId: string;
      tenantId: string;
      account: RiderAccount;
      type: RiderLedgerType;
      amount: number;
      orderId?: string | null;
      memo?: string;
      actor?: string;
    },
  ) {
    if (!Number.isInteger(input.amount)) {
      throw new BadRequestException('Rider ledger amounts are integer poisha');
    }
    if (input.amount === 0) return null;

    const last = await tx.riderLedgerEntry.findFirst({
      where: { riderId: input.riderId, account: input.account },
      orderBy: { seq: 'desc' },
      select: { balanceAfter: true },
    });

    try {
      return await tx.riderLedgerEntry.create({
        data: {
          riderId: input.riderId,
          tenantId: input.tenantId,
          account: input.account,
          type: input.type,
          amount: input.amount,
          balanceAfter: (last?.balanceAfter ?? 0) + input.amount,
          orderId: input.orderId ?? null,
          memo: input.memo ?? '',
          actor: input.actor ?? 'system',
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null; // already posted for this order
      throw err;
    }
  }

  /**
   * What a completed delivery does to a rider's books.
   *
   * Two entries, and they are independent of each other: the cash is the shop's, the fee is
   * the rider's. An order that was fully prepaid produces only the fee, because there was
   * nothing to collect — `post` drops a zero amount rather than writing a meaningless row.
   */
  async postDelivered(
    tx: GuardedTx,
    order: { id: string; tenantId: string; riderId: string | null; dueOnDelivery: number; code: string },
    feePerDelivery: number,
  ) {
    if (!order.riderId) return;

    await this.post(tx, {
      riderId: order.riderId,
      tenantId: order.tenantId,
      account: 'CASH',
      type: 'CASH_COLLECTED',
      amount: order.dueOnDelivery,
      orderId: order.id,
      memo: `Collected on ${order.code}`,
    });

    await this.post(tx, {
      riderId: order.riderId,
      tenantId: order.tenantId,
      account: 'EARNINGS',
      type: 'DELIVERY_FEE',
      amount: feePerDelivery,
      orderId: order.id,
      memo: `Delivery fee for ${order.code}`,
    });
  }

  /** Both balances for one rider, across every shop they carry for. */
  async balances(riderId: string): Promise<RiderBalances> {
    const [cash, earnings] = await Promise.all([
      this.latest(riderId, 'CASH'),
      this.latest(riderId, 'EARNINGS'),
    ]);
    return { cash, earnings };
  }

  private latest(riderId: string, account: RiderAccount): Promise<number> {
    return this.prisma.db.riderLedgerEntry
      .findFirst({
        where: { riderId, account },
        // seq, not createdAt. See the class comment.
        orderBy: { seq: 'desc' },
        select: { balanceAfter: true },
      })
      .then((row) => row?.balanceAfter ?? 0);
  }

  /**
   * A shop taking the cash in.
   *
   * Recorded against the shop that received it, which is the only honest way to write it
   * down: a rider carrying for three shops hands money to whichever counter they reach, and
   * pretending otherwise would make every reconciliation a guess.
   *
   * A shortfall is **not** silently turned into a penalty. The deposit is whatever was
   * actually handed over; what remains stays as cash in hand, visible to both sides, for a
   * human to settle. Software that quietly docks a worker's pay to make its own arithmetic
   * balance is not doing accounting.
   */
  async deposit(tenantId: string, riderId: string, amount: number, actor: string, memo?: string) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException('Enter how much cash was handed in');
    }

    const held = (await this.balances(riderId)).cash;
    if (amount > held) {
      throw new BadRequestException('That is more than this rider is carrying');
    }

    await this.prisma.db.$transaction((tx) =>
      this.post(tx, {
        riderId,
        tenantId,
        account: 'CASH',
        type: 'CASH_DEPOSITED',
        amount: -amount,
        memo: memo?.trim() || 'Cash handed in',
        actor,
      }),
    );
    return this.balances(riderId);
  }

  /** Paying a rider what they have earned, or correcting it with a reason attached. */
  async settleEarnings(
    tenantId: string,
    riderId: string,
    amount: number,
    type: 'PAYOUT' | 'ADJUSTMENT',
    actor: string,
    memo?: string,
  ) {
    if (!Number.isInteger(amount) || amount === 0) {
      throw new BadRequestException('Enter an amount');
    }
    if (type === 'PAYOUT' && amount <= 0) throw new BadRequestException('A payout is a positive amount');
    // An adjustment with no reason is an unexplained change to somebody's pay.
    if (type === 'ADJUSTMENT' && !memo?.trim()) {
      throw new BadRequestException('Say why this adjustment is being made');
    }

    await this.prisma.db.$transaction((tx) =>
      this.post(tx, {
        riderId,
        tenantId,
        account: 'EARNINGS',
        type,
        amount: type === 'PAYOUT' ? -amount : amount,
        memo: memo?.trim() || 'Paid out',
        actor,
      }),
    );
    return this.balances(riderId);
  }

  /** One rider's recent entries, for the shop's reconciliation screen. */
  statement(riderId: string, take = 50) {
    return this.prisma.db.riderLedgerEntry.findMany({
      where: { riderId },
      orderBy: { seq: 'desc' },
      take,
      select: {
        id: true, seq: true, account: true, type: true, amount: true,
        balanceAfter: true, memo: true, createdAt: true,
      },
    });
  }

  /**
   * Every rider a shop works with, and what each is holding.
   *
   * The balances are the rider's whole position, not this shop's share of it: a rider
   * carrying ৳4,000 has ৳4,000 on them whoever it came from, and that is the number that
   * matters when deciding whether to hand them another cash order.
   */
  async shopOverview(tenantId: string) {
    const links = await this.prisma.db.riderShop.findMany({
      where: { tenantId, approved: true, rider: { isActive: true } },
      select: { rider: { select: { id: true, name: true, phone: true, onDuty: true } } },
    });

    return Promise.all(
      links.map(async (link) => ({
        ...link.rider,
        ...(await this.balances(link.rider.id)),
      })),
    );
  }
}

/**
 * Whether this rider may be offered another cash order.
 *
 * A limit on cash in hand is the cheapest theft and loss control there is, and it is not an
 * accusation: a rider carrying a day's takings through a village at night is exposed to
 * more than temptation. Prepaid work is unaffected, because the risk being managed is the
 * cash and nothing else.
 */
export function overCashLimit(cashInHand: number, limit: number): boolean {
  return limit > 0 && cashInHand >= limit;
}
