import { Plan } from './enums';

/**
 * What each plan unlocks.
 *
 * Mode A is a fixed-fee SaaS, so this table IS the revenue model — without it FREE and PRO
 * are the same product and nobody upgrades.
 *
 * One deliberate omission: **marketplace listing is not gated**. It is tempting to sell it
 * as a premium feature, but we earn a commission on every marketplace order, so putting it
 * behind a paywall would cost us more in commission than it gains in subscription. Plans
 * gate the vendor's OWN storefront; the marketplace stays open to everyone.
 */
export const PLAN_FEATURES = {
  /** A vendor's own domain instead of a foodhub subdomain. */
  CUSTOM_DOMAIN: 'CUSTOM_DOMAIN',
  /** Require 50%/100% up front against hoax cash orders. */
  ADVANCE_PAYMENT: 'ADVANCE_PAYMENT',
  /** Points and store credit funded by the vendor. */
  LOYALTY: 'LOYALTY',
  /** Discount codes. */
  COUPONS: 'COUPONS',
  /** Collection from the counter. */
  PICKUP: 'PICKUP',
  /** The conversational ordering bot. */
  AI_ASSISTANT: 'AI_ASSISTANT',
  /** Customers choosing a delivery time. */
  SCHEDULED_ORDERS: 'SCHEDULED_ORDERS',
  /** Paid placement at the top of the marketplace feed. */
  PROMOTED_LISTING: 'PROMOTED_LISTING',
  /** Marketing pixels on the storefront. */
  MARKETING_PIXELS: 'MARKETING_PIXELS',
} as const;
export type PlanFeature = (typeof PLAN_FEATURES)[keyof typeof PLAN_FEATURES];

interface PlanSpec {
  label: string;
  /** Poisha per month. */
  price: number;
  features: PlanFeature[];
  /** Menu items allowed. The Free cap is the main reason a growing kitchen upgrades. */
  menuItems: number;
  /** Staff logins including the owner. */
  staffSeats: number;
  /** How far back the analytics dashboard may look. */
  analyticsDays: number;
  /** One-line reason to move up from the plan below. */
  pitch: string;
}

/*
 * Held in a local binding and re-exported, rather than referenced as `PLANS` from the
 * derived table below.
 *
 * TypeScript compiles a cross-reference between two exported consts into `exports.PLANS`,
 * and bundlers doing CJS interop can evaluate that before the assignment has run — which
 * shows up as `Cannot read properties of undefined` at build time and nowhere else.
 * A local const cannot be caught half-initialised.
 */
const PLAN_SPECS: Record<Plan, PlanSpec> = {
  FREE: {
    label: 'Free',
    price: 0,
    features: [],
    menuItems: 20,
    staffSeats: 1,
    analyticsDays: 7,
    pitch: 'Take orders on your own site, with no commission, forever.',
  },
  BASIC: {
    label: 'Basic',
    price: 1_500_00,
    features: [
      PLAN_FEATURES.CUSTOM_DOMAIN,
      PLAN_FEATURES.ADVANCE_PAYMENT,
      PLAN_FEATURES.LOYALTY,
      PLAN_FEATURES.COUPONS,
      PLAN_FEATURES.PICKUP,
      PLAN_FEATURES.MARKETING_PIXELS,
    ],
    menuItems: 500,
    staffSeats: 5,
    analyticsDays: 90,
    pitch: 'Your own domain, discounts, and money up front against fake orders.',
  },
  PRO: {
    label: 'Pro',
    price: 4_000_00,
    features: [
      PLAN_FEATURES.CUSTOM_DOMAIN,
      PLAN_FEATURES.ADVANCE_PAYMENT,
      PLAN_FEATURES.LOYALTY,
      PLAN_FEATURES.COUPONS,
      PLAN_FEATURES.PICKUP,
      PLAN_FEATURES.MARKETING_PIXELS,
      PLAN_FEATURES.AI_ASSISTANT,
      PLAN_FEATURES.SCHEDULED_ORDERS,
      PLAN_FEATURES.PROMOTED_LISTING,
    ],
    menuItems: 5_000,
    staffSeats: 50,
    analyticsDays: 365,
    pitch: 'An AI assistant taking orders, scheduled delivery, and top placement.',
  },
};

export const PLANS = PLAN_SPECS;

export function planAllows(plan: Plan, feature: PlanFeature): boolean {
  return PLAN_SPECS[plan].features.includes(feature);
}

/** The cheapest plan that includes a feature — what an upgrade prompt should offer. */
export function planRequiredFor(feature: PlanFeature): Plan {
  const order: Plan[] = ['FREE', 'BASIC', 'PRO'];
  return order.find((p) => planAllows(p, feature)) ?? 'PRO';
}

/**
 * Settings that must be switched OFF when a vendor drops to a plan that no longer
 * includes them. Without this a vendor upgrades for a month, turns everything on, then
 * downgrades and keeps it all — and the subscription revenue leaks away quietly.
 */
export const FEATURE_SETTING_FIELD: Partial<Record<PlanFeature, string>> = {
  [PLAN_FEATURES.LOYALTY]: 'loyaltyEnabled',
  [PLAN_FEATURES.AI_ASSISTANT]: 'aiAssistantEnabled',
  [PLAN_FEATURES.PICKUP]: 'pickupEnabled',
};

/**
 * The billing view of the same table.
 *
 * Derived rather than written out again: a second hand-maintained price list is how a
 * vendor ends up seeing ৳1,500 on the pricing page and being charged ৳2,000.
 */
export const PLAN_PRICING: Record<Plan, { monthly: number; label: string; features: string[] }> = {
  FREE: {
    monthly: PLAN_SPECS.FREE.price,
    label: PLAN_SPECS.FREE.label,
    features: [
      'Storefront on a foodhub subdomain',
      `Up to ${PLAN_SPECS.FREE.menuItems} menu items`,
      'Marketplace listing',
      'Cash on delivery',
    ],
  },
  BASIC: {
    monthly: PLAN_SPECS.BASIC.price,
    label: PLAN_SPECS.BASIC.label,
    features: [
      'Your own domain + free SSL',
      'Advance payment against fake orders',
      'Discount codes and loyalty points',
      'Pickup orders',
      `${PLAN_SPECS.BASIC.staffSeats} staff logins · 90-day analytics`,
    ],
  },
  PRO: {
    monthly: PLAN_SPECS.PRO.price,
    label: PLAN_SPECS.PRO.label,
    features: [
      'Everything in Basic',
      'AI assistant that takes orders',
      'Scheduled and pre-orders',
      'Promoted placement on the marketplace',
      `${PLAN_SPECS.PRO.staffSeats} staff logins · 365-day analytics`,
    ],
  },
};
