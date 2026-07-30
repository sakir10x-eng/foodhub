import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService, GuardedTx } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

export interface LoyaltyConfig {
  enabled: boolean;
  pointsPerHundred: number;
  pointValue: number;
  minRedeemPoints: number;
}

/**
 * Per-vendor loyalty points and store credit.
 *
 * Keyed by phone number, not user id: most BD food orders are guest checkouts, and a
 * loyalty programme only signed-in customers can use is a loyalty programme almost
 * nobody uses.
 *
 * Two rules keep it honest:
 *   - points are awarded on DELIVERED, never at checkout, so a cancelled order can't
 *     mint points;
 *   - redemption is debited inside the order transaction, so a failed order can't spend
 *     a balance that was already spent.
 */
@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(private readonly prisma: PrismaService) {}

  async config(tenantId: string): Promise<LoyaltyConfig> {
    const tenant = await this.prisma.db.tenant.findUnique({
      where: { id: tenantId },
      select: { loyaltyEnabled: true, pointsPerHundred: true, pointValue: true, minRedeemPoints: true },
    });
    return {
      enabled: tenant?.loyaltyEnabled ?? false,
      pointsPerHundred: tenant?.pointsPerHundred ?? 1,
      pointValue: tenant?.pointValue ?? 100,
      minRedeemPoints: tenant?.minRedeemPoints ?? 50,
    };
  }

  /** The customer's balance at this vendor. Never creates a row for a read. */
  async balance(tenantId: string, phone: string) {
    const normalized = normalizePhone(phone);
    return TenantContext.runAsTenant(tenantId, async () => {
      const [account, config] = await Promise.all([
        this.prisma.db.loyaltyAccount.findUnique({ where: { tenantId_phone: { tenantId, phone: normalized } } }),
        this.config(tenantId),
      ]);
      const points = account?.pointsBalance ?? 0;
      return {
        points,
        wallet: account?.walletBalance ?? 0,
        lifetimePoints: account?.lifetimePoints ?? 0,
        tier: account?.tier ?? 'BRONZE',
        config,
        /** What those points are worth right now, if redeemable at all. */
        redeemableValue: points >= config.minRedeemPoints ? points * config.pointValue : 0,
      };
    });
  }

  /**
   * How much of a subtotal this customer may cover with points + wallet.
   * Capped at the goods value so loyalty can never pay the delivery fee or go negative.
   */
  async quoteRedemption(
    tenantId: string,
    phone: string,
    subtotal: number,
    requestedPoints: number,
    useWallet: boolean,
  ) {
    const { points, wallet, config } = await this.balance(tenantId, phone);
    if (!config.enabled) return { pointsUsed: 0, walletUsed: 0, discount: 0 };

    let remaining = subtotal;
    let pointsUsed = 0;

    if (requestedPoints > 0 && points >= config.minRedeemPoints) {
      const usable = Math.min(requestedPoints, points);
      const valueWanted = usable * config.pointValue;
      const valueAllowed = Math.min(valueWanted, remaining);
      // Only spend whole points that actually buy something.
      pointsUsed = Math.floor(valueAllowed / config.pointValue);
      remaining -= pointsUsed * config.pointValue;
    }

    const walletUsed = useWallet ? Math.min(wallet, remaining) : 0;

    return {
      pointsUsed,
      walletUsed,
      discount: pointsUsed * config.pointValue + walletUsed,
    };
  }

  /** Debit points/wallet as part of the order transaction. Must not run on its own. */
  async spend(
    tx: GuardedTx,
    tenantId: string,
    phone: string,
    orderId: string,
    pointsUsed: number,
    walletUsed: number,
  ) {
    if (pointsUsed === 0 && walletUsed === 0) return;
    const normalized = normalizePhone(phone);

    const account = await tx.loyaltyAccount.findUnique({
      where: { tenantId_phone: { tenantId, phone: normalized } },
    });
    // Re-checked inside the transaction: the quote above was advisory, and a concurrent
    // order could have spent the same balance in between.
    if (!account || account.pointsBalance < pointsUsed || account.walletBalance < walletUsed) {
      throw new BadRequestException('Your points balance changed — review the order and try again');
    }

    await tx.loyaltyAccount.update({
      where: { id: account.id },
      data: {
        pointsBalance: { decrement: pointsUsed },
        walletBalance: { decrement: walletUsed },
      },
    });

    if (pointsUsed > 0) {
      await tx.loyaltyTransaction.create({
        data: { tenantId, accountId: account.id, orderId, type: 'REDEEM', points: -pointsUsed, memo: 'Points redeemed' },
      });
    }
    if (walletUsed > 0) {
      await tx.loyaltyTransaction.create({
        data: { tenantId, accountId: account.id, orderId, type: 'DEBIT', amount: -walletUsed, memo: 'Store credit used' },
      });
    }
  }

  /**
   * Award points for a delivered order. Idempotent: a replayed DELIVERED finds the
   * order already stamped with `pointsEarned` and does nothing.
   */
  async awardForDelivery(
    tx: GuardedTx,
    tenantId: string,
    order: { id: string; code: string; customerPhone: string; subtotal: number; discount: number; pointsEarned: number },
  ): Promise<number> {
    if (order.pointsEarned > 0) return 0;

    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { loyaltyEnabled: true, pointsPerHundred: true },
    });
    if (!tenant?.loyaltyEnabled) return 0;

    // Earn on what the customer actually paid for goods — not on the delivery fee, and
    // not on the part already covered by a previous reward.
    const eligible = Math.max(0, order.subtotal - order.discount);
    const points = Math.floor((eligible / 10_000) * tenant.pointsPerHundred);
    if (points <= 0) return 0;

    const phone = normalizePhone(order.customerPhone);
    const account = await tx.loyaltyAccount.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, phone, pointsBalance: points, lifetimePoints: points },
      update: {
        pointsBalance: { increment: points },
        lifetimePoints: { increment: points },
      },
    });

    await tx.loyaltyTransaction.create({
      data: { tenantId, accountId: account.id, orderId: order.id, type: 'EARN', points, memo: `Earned on ${order.code}` },
    });

    // Tier is derived from lifetime points and only ever moves up.
    const tier = account.lifetimePoints >= 1000 ? 'GOLD' : account.lifetimePoints >= 300 ? 'SILVER' : 'BRONZE';
    if (tier !== account.tier) {
      await tx.loyaltyAccount.update({ where: { id: account.id }, data: { tier } });
    }

    return points;
  }

  /**
   * Credit inside a caller's transaction.
   *
   * Referral payouts need this: the credit and the "already rewarded" stamp must commit
   * together, or a crash between them pays one side and forgets it happened.
   */
  async creditInTx(tx: GuardedTx, tenantId: string, phone: string, amount: number, memo: string) {
    if (amount <= 0) return;
    const normalized = normalizePhone(phone);
    const account = await tx.loyaltyAccount.upsert({
      where: { tenantId_phone: { tenantId, phone: normalized } },
      create: { tenantId, phone: normalized, walletBalance: amount },
      update: { walletBalance: { increment: amount } },
    });
    await tx.loyaltyTransaction.create({
      data: { tenantId, accountId: account.id, type: 'CREDIT', amount, memo },
    });
  }

  /** Vendor or platform grants store credit — refunds, apologies, promotions. */
  async grantCredit(tenantId: string, phone: string, amount: number, memo: string) {
    if (amount <= 0) throw new BadRequestException('Credit amount must be positive');
    const normalized = normalizePhone(phone);

    return TenantContext.runAsTenant(tenantId, async () => {
      const account = await this.prisma.db.loyaltyAccount.upsert({
        where: { tenantId_phone: { tenantId, phone: normalized } },
        create: { tenantId, phone: normalized, walletBalance: amount },
        update: { walletBalance: { increment: amount } },
      });
      await this.prisma.db.loyaltyTransaction.create({
        data: { tenantId, accountId: account.id, type: 'CREDIT', amount, memo },
      });
      return { walletBalance: account.walletBalance + (account.walletBalance === amount ? 0 : amount) };
    });
  }

  async history(tenantId: string, phone: string, limit = 30) {
    const normalized = normalizePhone(phone);
    return TenantContext.runAsTenant(tenantId, async () => {
      const account = await this.prisma.db.loyaltyAccount.findUnique({
        where: { tenantId_phone: { tenantId, phone: normalized } },
        select: { id: true },
      });
      if (!account) return [];
      return this.prisma.db.loyaltyTransaction.findMany({
        where: { accountId: account.id },
        orderBy: { seq: 'desc' },
        take: limit,
      });
    });
  }

  /** Vendor-facing: who the regulars are. */
  async topCustomers(tenantId: string, limit = 20) {
    return this.prisma.readOnly.loyaltyAccount.findMany({
      where: { tenantId },
      orderBy: { lifetimePoints: 'desc' },
      take: limit,
      select: { phone: true, name: true, pointsBalance: true, lifetimePoints: true, walletBalance: true, tier: true },
    });
  }
}

/** Last 10 digits — the same identity rule order tracking uses. */
export function normalizePhone(phone: string): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.slice(-10);
}
