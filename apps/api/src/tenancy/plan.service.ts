import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  FEATURE_SETTING_FIELD,
  PLANS,
  Plan,
  PlanFeature,
  planAllows,
  planRequiredFor,
} from '@foodhub/shared';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../common/tenant-context';

/**
 * The paywall.
 *
 * Mode A charges a fixed monthly fee, so this service is the difference between a
 * subscription business and a free one. It is enforced server-side on every write that
 * turns a paid feature on — a locked button in the panel is a hint, not a boundary.
 */
@Injectable()
export class PlanService {
  private readonly logger = new Logger(PlanService.name);

  constructor(private readonly prisma: PrismaService) {}

  async planFor(tenantId: string): Promise<Plan> {
    const tenant = await TenantContext.runAsPlatform('plan lookup for one explicit tenant', () =>
      this.prisma.db.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }),
    );
    return (tenant?.plan ?? 'FREE') as Plan;
  }

  async allows(tenantId: string, feature: PlanFeature): Promise<boolean> {
    return planAllows(await this.planFor(tenantId), feature);
  }

  /** Throws with the upgrade the vendor actually needs, not a bare 403. */
  async require(tenantId: string, feature: PlanFeature): Promise<void> {
    const plan = await this.planFor(tenantId);
    if (planAllows(plan, feature)) return;

    const needed = planRequiredFor(feature);
    throw new ForbiddenException(
      `${LABELS[feature]} is on the ${PLANS[needed].label} plan (৳${PLANS[needed].price / 100}/month). ` +
        `You are on ${PLANS[plan].label}.`,
    );
  }

  /**
   * Applied on every plan change.
   *
   * Downgrading has to switch OFF the settings the new plan does not include. Without
   * this a vendor pays for one month of Pro, turns on the assistant and loyalty, drops
   * back to Free, and keeps both forever — the subscription leaks away one vendor at a
   * time and nothing in the system notices.
   */
  async reconcileAfterPlanChange(tenantId: string, newPlan: Plan): Promise<string[]> {
    const lost = (Object.keys(FEATURE_SETTING_FIELD) as PlanFeature[]).filter(
      (f) => !planAllows(newPlan, f),
    );
    if (lost.length === 0) return [];

    const data: Record<string, unknown> = {};
    for (const feature of lost) data[FEATURE_SETTING_FIELD[feature]!] = false;

    // Advance payment has no single boolean — it is a percentage, so it resets to zero.
    if (!planAllows(newPlan, 'ADVANCE_PAYMENT')) {
      data.advancePercent = 0;
      data.codEnabled = true; // otherwise the store would accept nothing at all
    }
    data.menuVersion = { increment: 1 };

    const disabled: string[] = [];
    await TenantContext.runAsTenant(tenantId, async () => {
      const before = await this.prisma.db.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { loyaltyEnabled: true, aiAssistantEnabled: true, pickupEnabled: true, advancePercent: true },
      });
      if (before.loyaltyEnabled && data.loyaltyEnabled === false) disabled.push('Loyalty');
      if (before.aiAssistantEnabled && data.aiAssistantEnabled === false) disabled.push('AI assistant');
      if (before.pickupEnabled && data.pickupEnabled === false) disabled.push('Pickup');
      if (before.advancePercent > 0 && data.advancePercent === 0) disabled.push('Advance payment');

      await this.prisma.db.tenant.update({ where: { id: tenantId }, data });
    });

    if (disabled.length) {
      this.logger.log(`Tenant ${tenantId} moved to ${newPlan}; turned off: ${disabled.join(', ')}`);
    }
    return disabled;
  }

  /** Staff seats are a plan limit too, checked when a vendor invites someone. */
  async assertSeatAvailable(tenantId: string): Promise<void> {
    const plan = await this.planFor(tenantId);
    const seats = PLANS[plan].staffSeats;
    const used = await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.user.count({ where: { role: { in: ['VENDOR_OWNER', 'VENDOR_STAFF'] }, isActive: true } }),
    );
    if (used >= seats) {
      throw new ForbiddenException(
        `The ${PLANS[plan].label} plan includes ${seats} staff login${seats === 1 ? '' : 's'}. Upgrade to add more.`,
      );
    }
  }

  /** Menu size is a plan limit. Checked before a create, never enforced retroactively. */
  async assertMenuRoom(tenantId: string): Promise<void> {
    const plan = await this.planFor(tenantId);
    const cap = PLANS[plan].menuItems;
    const used = await TenantContext.runAsTenant(tenantId, () =>
      this.prisma.db.product.count({ where: { isArchived: false } }),
    );
    if (used >= cap) {
      throw new ForbiddenException(
        `The ${PLANS[plan].label} plan holds ${cap} menu items. Upgrade to add more.`,
      );
    }
  }

  /** Analytics windows are capped by plan — the clamp, not an error. */
  async clampAnalyticsDays(tenantId: string, requested: number): Promise<number> {
    const plan = await this.planFor(tenantId);
    return Math.min(requested, PLANS[plan].analyticsDays);
  }
}

const LABELS: Record<PlanFeature, string> = {
  CUSTOM_DOMAIN: 'A custom domain',
  ADVANCE_PAYMENT: 'Advance payment',
  LOYALTY: 'The loyalty programme',
  COUPONS: 'Discount codes',
  PICKUP: 'Pickup',
  AI_ASSISTANT: 'The AI assistant',
  SCHEDULED_ORDERS: 'Scheduled orders',
  PROMOTED_LISTING: 'Promoted listings',
  MARKETING_PIXELS: 'Marketing pixels',
};
