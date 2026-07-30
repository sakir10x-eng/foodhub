import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';
import { LoyaltyService } from '../loyalty/loyalty.service';

/**
 * Double-sided referrals, paid into the wallet the loyalty programme already provides.
 *
 * The whole design turns on WHEN the reward is paid: on the invited customer's first
 * DELIVERED order — never on signup, never at checkout. Paying earlier is an invitation to
 * farm codes with throwaway numbers, and in Bangladesh a throwaway SIM costs less than the
 * reward would.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyService,
  ) {}

  /** The code a customer shares. Created on demand and stable thereafter. */
  async codeFor(tenantId: string, phone: string) {
    const tenant = await TenantContext.runAsPlatform('referral settings for one explicit tenant', () =>
      this.prisma.db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          referralEnabled: true, referrerReward: true, refereeReward: true, referralMinSpend: true,
        },
      }),
    );
    if (!tenant.referralEnabled) throw new NotFoundException('This store is not running a referral programme');

    return TenantContext.runAsTenant(tenantId, async () => {
      const existing = await this.prisma.db.referral.findFirst({
        where: { referrerPhone: phone, refereePhone: null },
      });
      if (existing) return { code: existing.code, ...rewards(tenant) };

      // Derived from the phone so the same customer always gets the same code, even after
      // clearing their browser — a code you cannot get back is a code nobody shares.
      const code = makeCode(phone);
      await this.prisma.db.referral.create({ data: { tenantId, code, referrerPhone: phone } });
      return { code, ...rewards(tenant) };
    });
  }

  /**
   * Bind a code to a new customer at checkout.
   *
   * Nothing is paid here. Self-referral and existing customers are refused, because both
   * are free money for one phone number.
   */
  async claim(tenantId: string, code: string, refereePhone: string) {
    return TenantContext.runAsTenant(tenantId, async () => {
      const referral = await this.prisma.db.referral.findFirst({
        where: { code: code.trim().toUpperCase(), refereePhone: null },
      });
      if (!referral) throw new BadRequestException('That invite code is not valid');
      if (referral.referrerPhone === refereePhone) {
        throw new BadRequestException('You cannot use your own invite code');
      }

      const priorOrders = await this.prisma.db.order.count({
        where: { customerPhone: refereePhone, status: { not: 'CANCELLED' } },
      });
      if (priorOrders > 0) {
        throw new BadRequestException('Invite codes are for your first order at this store');
      }

      await this.prisma.db.referral.update({ where: { id: referral.id }, data: { refereePhone } });
      return { ok: true };
    });
  }

  /**
   * Pay both sides, once, when the referred customer's first order is delivered.
   *
   * The `rewardedAt` stamp and the two credits commit in one transaction, so a replayed
   * DELIVERED pays nobody twice and a crash cannot pay one side only.
   */
  async settleOnDelivery(tenantId: string, order: { id: string; customerPhone: string; total: number }) {
    const tenant = await TenantContext.runAsPlatform('referral settings for one explicit tenant', () =>
      this.prisma.db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: {
          referralEnabled: true, referrerReward: true, refereeReward: true, referralMinSpend: true,
        },
      }),
    );
    if (!tenant.referralEnabled) return;

    await TenantContext.runAsTenant(tenantId, async () => {
      const referral = await this.prisma.db.referral.findFirst({
        where: { refereePhone: order.customerPhone, rewardedAt: null },
      });
      if (!referral) return;

      // A ৳50 order that earns ৳100 of credit is a loss, not a growth channel.
      if (order.total < tenant.referralMinSpend) {
        this.logger.log(
          `Referral ${referral.code}: order below the ৳${tenant.referralMinSpend / 100} minimum, not paid`,
        );
        return;
      }

      await this.prisma.db.$transaction(async (tx) => {
        const claimed = await tx.referral.updateMany({
          where: { id: referral.id, rewardedAt: null },
          data: { rewardedAt: new Date(), orderId: order.id },
        });
        if (claimed.count === 0) return; // another worker already paid it

        await this.loyalty.creditInTx(
          tx, tenantId, referral.referrerPhone, tenant.referrerReward,
          'Invite reward — someone you invited ordered',
        );
        await this.loyalty.creditInTx(
          tx, tenantId, order.customerPhone, tenant.refereeReward,
          'Welcome credit from an invite',
        );
      });

      this.logger.log(`Referral ${referral.code} paid out on order ${order.id}`);
    });
  }

  /** What the referring customer has earned so far. */
  async statsFor(tenantId: string, phone: string) {
    return TenantContext.runAsTenant(tenantId, async () => {
      const [invited, rewarded] = await Promise.all([
        this.prisma.db.referral.count({ where: { referrerPhone: phone, refereePhone: { not: null } } }),
        this.prisma.db.referral.count({ where: { referrerPhone: phone, rewardedAt: { not: null } } }),
      ]);
      return { invited, rewarded };
    });
  }
}

function rewards(t: { referrerReward: number; refereeReward: number; referralMinSpend: number }) {
  return { referrerReward: t.referrerReward, refereeReward: t.refereeReward, minSpend: t.referralMinSpend };
}

/**
 * A short code derived from the phone number.
 *
 * Deterministic, so it survives a cleared browser. The alphabet omits O/0 and I/1 because
 * these codes get read aloud over the phone far more often than they get tapped.
 */
function makeCode(phone: string): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digits = phone.replace(/\D/g, '');
  let hash = 0;
  for (const ch of digits) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ALPHABET[hash % ALPHABET.length];
    hash = Math.floor(hash / ALPHABET.length) + 7919;
  }
  return out;
}
