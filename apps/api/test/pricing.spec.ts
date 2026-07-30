import {
  applyBps,
  assertPoisha,
  canTransition,
  Channel,
  formatBDT,
  MAX_QTY_PER_LINE,
  priceCart,
  deliveryProgress,
  resolveZone,
  splitEvenly,
  splitPayment,
  taka,
  PLANS,
  PLAN_PRICING,
  PLAN_FEATURES,
  planRequiredFor,
  FEATURE_SETTING_FIELD,
  smsConfigSchema,
} from '@foodhub/shared';
import { partsFor } from '../src/infra/transports/sms.transport';
import { isOpenAt } from '../src/ops/ops.service';
import { toTaka, fromTaka } from '../src/payments/bkash.transport';

describe('money', () => {
  it('keeps amounts as integer poisha', () => {
    expect(taka(12.34)).toBe(1234);
    expect(taka(0.1) + taka(0.2)).toBe(taka(0.3)); // the float trap, closed
  });

  it('rejects non-integer amounts', () => {
    expect(() => assertPoisha(10.5)).toThrow();
    expect(() => assertPoisha('100' as unknown)).toThrow();
  });

  it('applies basis points with half-up rounding', () => {
    expect(applyBps(10_000, 1500)).toBe(1500); // 15% of ৳100
    expect(applyBps(333, 1500)).toBe(50); // 49.95 -> 50
    expect(() => applyBps(100, 20_000)).toThrow();
  });

  it('splits without losing a poisha', () => {
    const parts = splitEvenly(1000, 3);
    expect(parts).toEqual([334, 333, 333]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('formats for display only', () => {
    expect(formatBDT(125_000)).toBe('৳1,250');
  });
});

describe('priceCart', () => {
  const items = [
    { productId: 'a', name: 'Kacchi', price: 42_000, qty: 2 },
    { productId: 'b', name: 'Borhani', price: 6_000, qty: 1 },
  ];
  const base = { items, deliveryFee: 6_000, commissionRateBps: 1500 };

  it('computes the same subtotal on both channels', () => {
    const own = priceCart({ ...base, channel: Channel.OWN_STORE });
    const market = priceCart({ ...base, channel: Channel.MARKETPLACE });
    expect(own.subtotal).toBe(90_000);
    expect(market.subtotal).toBe(90_000);
    expect(own.total).toBe(96_000);
  });

  // The core of the business model: own_store money never passes through us, so a
  // per-order commission there would be unenforceable. It must always be zero.
  it('never charges commission on own_store', () => {
    const own = priceCart({ ...base, channel: Channel.OWN_STORE, commissionRateBps: 9999 });
    expect(own.commissionAmount).toBe(0);
    expect(own.vendorPayable).toBe(0);
  });

  it('charges commission on marketplace, on goods value only', () => {
    const market = priceCart({ ...base, channel: Channel.MARKETPLACE });
    // 15% of the 90,000 subtotal — NOT of the 96,000 total, because the vendor pays
    // the rider out of the delivery fee in v1.
    expect(market.commissionAmount).toBe(13_500);
    expect(market.vendorPayable).toBe(96_000 - 13_500);
  });

  it('discounts before commission', () => {
    const market = priceCart({ ...base, channel: Channel.MARKETPLACE, discount: 10_000 });
    expect(market.discount).toBe(10_000);
    expect(market.total).toBe(86_000);
    expect(market.commissionAmount).toBe(applyBps(80_000, 1500));
  });

  it('caps a discount at the subtotal so an order can never become a payout', () => {
    const r = priceCart({ ...base, channel: Channel.OWN_STORE, discount: 500_000 });
    expect(r.discount).toBe(90_000);
    expect(r.total).toBe(6_000); // delivery fee still owed
  });

  it('subtracts an absorbed gateway fee from the vendor payable, not the customer total', () => {
    const r = priceCart({ ...base, channel: Channel.MARKETPLACE, gatewayFeeBps: 250 });
    expect(r.total).toBe(96_000);
    expect(r.vendorPayable).toBe(96_000 - 13_500 - applyBps(96_000, 250));
  });

  it('rejects impossible carts', () => {
    expect(() => priceCart({ ...base, items: [], channel: Channel.OWN_STORE })).toThrow('empty');
    expect(() =>
      priceCart({
        ...base,
        items: [{ productId: 'a', name: 'x', price: 100, qty: MAX_QTY_PER_LINE + 1 }],
        channel: Channel.OWN_STORE,
      }),
    ).toThrow('quantity');
    expect(() => priceCart({ ...base, deliveryFee: -1, channel: Channel.OWN_STORE })).toThrow();
  });

  it('snapshots name and price per line', () => {
    const r = priceCart({ ...base, channel: Channel.OWN_STORE });
    expect(r.lines[0]).toMatchObject({ nameSnapshot: 'Kacchi', priceSnapshot: 42_000, lineTotal: 84_000 });
  });
});

describe('delivery zones', () => {
  const zones = [
    { id: 'in', label: 'Inside', fee: 6_000, minOrder: 0, areas: ['Dhanmondi', 'Gulshan'] },
    { id: 'out', label: 'Outside', fee: 12_000, minOrder: 0, areas: [] },
  ];

  it('matches an area case-insensitively', () => {
    expect(resolveZone(zones, 'dhanmondi')?.id).toBe('in');
    expect(resolveZone(zones, 'GULSHAN')?.id).toBe('in');
  });

  it('falls back to the first zone for an unknown area', () => {
    expect(resolveZone(zones, 'Sylhet')?.id).toBe('in');
    expect(resolveZone([], 'Dhanmondi')).toBeNull();
  });
});

describe('order state machine', () => {
  it('allows only the documented happy path', () => {
    expect(canTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(canTransition('CONFIRMED', 'PREPARING')).toBe(true);
    expect(canTransition('ON_THE_WAY', 'DELIVERED')).toBe(true);
  });

  it('refuses to skip ahead or walk backwards', () => {
    expect(canTransition('PENDING', 'DELIVERED')).toBe(false);
    expect(canTransition('DELIVERED', 'PREPARING')).toBe(false);
    expect(canTransition('REFUNDED', 'DELIVERED')).toBe(false);
  });

  it('allows cancellation until the food is out, and refunds after', () => {
    expect(canTransition('PREPARING', 'CANCELLED')).toBe(true);
    expect(canTransition('DELIVERED', 'REFUNDED')).toBe(true);
    expect(canTransition('DELIVERED', 'CANCELLED')).toBe(false);
  });
});

/**
 * Payment policy. This is a money control against hoax cash-on-delivery orders, so the
 * split has to be exact and the COD gate has to be closed whenever an advance is owed.
 */
describe('splitPayment', () => {
  const none = { codEnabled: true, advancePercent: 0, advanceThreshold: 0 };
  const half = { codEnabled: true, advancePercent: 50, advanceThreshold: 0 };
  const full = { codEnabled: true, advancePercent: 100, advanceThreshold: 0 };

  it('demands nothing when no advance is configured', () => {
    const s = splitPayment(106_000, 100_000, none);
    expect(s.advanceAmount).toBe(0);
    expect(s.dueOnDelivery).toBe(106_000);
    expect(s.codAllowed).toBe(true);
  });

  it('splits the total in half, delivery fee included', () => {
    // 53,000 of 106,000 — the fee is part of what the vendor is out of pocket for.
    const s = splitPayment(106_000, 100_000, half);
    expect(s.advanceAmount).toBe(53_000);
    expect(s.dueOnDelivery).toBe(53_000);
    expect(s.advanceAmount + s.dueOnDelivery).toBe(106_000);
  });

  it('closes cash on delivery whenever an advance is owed', () => {
    // Even with codEnabled true: a hoax order the customer never pays for is the whole
    // problem the advance exists to solve.
    expect(splitPayment(106_000, 100_000, half).codAllowed).toBe(false);
    expect(splitPayment(106_000, 100_000, full).codAllowed).toBe(false);
    expect(splitPayment(106_000, 100_000, { ...none, codEnabled: false }).codAllowed).toBe(false);
  });

  it('leaves nothing at the door on full prepayment', () => {
    const s = splitPayment(106_000, 100_000, full);
    expect(s.advanceAmount).toBe(106_000);
    expect(s.dueOnDelivery).toBe(0);
  });

  it('rounds the advance up so the doorstep amount can never exceed the policy', () => {
    // 50% of 10,001 is 5,000.5 — the customer prepays 5,001 and owes 5,000.
    const s = splitPayment(10_001, 10_001, half);
    expect(s.advanceAmount).toBe(5_001);
    expect(s.dueOnDelivery).toBe(5_000);
  });

  it('exempts orders below the threshold', () => {
    const policy = { codEnabled: true, advancePercent: 50, advanceThreshold: 200_000 };
    // Threshold is checked against the SUBTOTAL: "advance above ৳2000" means ৳2000 of
    // food, not food plus whatever the delivery happens to cost.
    const small = splitPayment(106_000, 100_000, policy);
    expect(small.advanceRequired).toBe(false);
    expect(small.codAllowed).toBe(true);

    const big = splitPayment(206_000, 200_000, policy);
    expect(big.advanceRequired).toBe(true);
    expect(big.advanceAmount).toBe(103_000);
  });

  it('never demands more than the order is worth', () => {
    expect(splitPayment(0, 0, full).advanceAmount).toBe(0);
    expect(splitPayment(500, 500, full).dueOnDelivery).toBe(0);
  });
});

/**
 * Pickup. The whole point is that no rider is involved, so nothing about the delivery
 * leg — fee, zone, minimum — may leak into a collected order.
 */
describe('pickup orders', () => {
  const items = [{ productId: 'p1', name: 'Kacchi', price: 42_000, qty: 1 }];

  it('carries no delivery fee', () => {
    const priced = priceCart({
      items,
      deliveryFee: 0, // checkout passes 0 for PICKUP; the zone is never resolved
      channel: Channel.OWN_STORE,
      commissionRateBps: 0,
    });
    expect(priced.deliveryFee).toBe(0);
    expect(priced.total).toBe(42_000);
  });

  it('still refuses a negative total if a discount is somehow larger', () => {
    const priced = priceCart({
      items,
      deliveryFee: 0,
      discount: 99_999_00, // clamped to the subtotal
      channel: Channel.OWN_STORE,
      commissionRateBps: 0,
    });
    expect(priced.total).toBe(0);
  });

  it('an advance on a pickup order is computed on the goods alone', () => {
    // No delivery fee means total === subtotal, so a 50% policy takes half the food.
    const s = splitPayment(42_000, 42_000, { codEnabled: true, advancePercent: 50, advanceThreshold: 0 });
    expect(s.advanceAmount).toBe(21_000);
    expect(s.dueOnDelivery).toBe(21_000);
  });
});

/**
 * Plans. This table is the Mode A revenue model, so the tests here are about money
 * leaking rather than about correctness of a calculation.
 */
describe('plan entitlements', () => {
  it('gives Free nothing paid, and Pro everything Basic has', () => {
    expect(PLANS.FREE.features).toHaveLength(0);
    for (const f of PLANS.BASIC.features) {
      expect(PLANS.PRO.features).toContain(f);
    }
  });

  it('never gates marketplace listing', () => {
    // Deliberate: we earn commission on marketplace orders, so paywalling the listing
    // would cost more in commission than it earns in subscription.
    const all = [...PLANS.FREE.features, ...PLANS.BASIC.features, ...PLANS.PRO.features];
    expect(all).not.toContain('MARKETPLACE_LISTING' as never);
  });

  it('points an upgrade prompt at the cheapest plan that has the feature', () => {
    expect(planRequiredFor(PLAN_FEATURES.ADVANCE_PAYMENT)).toBe('BASIC');
    expect(planRequiredFor(PLAN_FEATURES.AI_ASSISTANT)).toBe('PRO');
  });

  it('knows which settings must be switched off on a downgrade', () => {
    // Every toggle-backed paid feature needs an entry, or a downgraded vendor keeps it.
    const toggleBacked = [PLAN_FEATURES.LOYALTY, PLAN_FEATURES.AI_ASSISTANT, PLAN_FEATURES.PICKUP];
    for (const f of toggleBacked) {
      expect(FEATURE_SETTING_FIELD[f]).toBeTruthy();
    }
  });

  it('keeps the billing price list in step with the entitlement table', () => {
    // PLAN_PRICING is derived, so this guards against someone un-deriving it later.
    for (const plan of ['FREE', 'BASIC', 'PRO'] as const) {
      expect(PLAN_PRICING[plan].monthly).toBe(PLANS[plan].price);
      expect(PLAN_PRICING[plan].label).toBe(PLANS[plan].label);
    }
  });
});

/**
 * SMS cost. A single Bengali character switches a message to UCS-2 and cuts the per-part
 * budget from 160 characters to 70 — which is why order copy on that channel is English.
 */
describe('SMS part counting', () => {
  it('fits a short English confirmation in one part', () => {
    expect(partsFor('Order FH1A4K received - Tk900. We will confirm shortly.')).toBe(1);
  });

  it('charges three parts for the same message in Bangla', () => {
    const bangla = 'আপনার অর্ডার FH1A4K পাওয়া গেছে — ৳৯০০। রেস্টুরেন্ট নিশ্চিত করলেই জানিয়ে দেব।';
    expect(partsFor(bangla)).toBeGreaterThan(1);
  });

  it('counts a 160-character English message as one part and 161 as two', () => {
    expect(partsFor('a'.repeat(160))).toBe(1);
    expect(partsFor('a'.repeat(161))).toBe(2);
  });
});

/**
 * Modifiers. These change what a line costs, so the arithmetic has to be exact and the
 * "options may be free but never negative" rule has to hold — a negative option would be
 * a discount invisible to coupons, commission and the ledger.
 */
describe('modifier pricing', () => {
  const base = { productId: 'p1', name: 'Pizza', price: 60_000, qty: 2 };

  it('adds every chosen option to the unit price, then multiplies', () => {
    const priced = priceCart({
      items: [{
        ...base,
        modifiers: [
          { groupName: 'Size', optionName: 'Large', priceDelta: 20_000 },
          { groupName: 'Extras', optionName: 'Extra cheese', priceDelta: 5_000 },
        ],
      }],
      deliveryFee: 6_000,
      channel: Channel.OWN_STORE,
      commissionRateBps: 0,
    });
    // (600 + 200 + 50) x 2 = 1,700
    expect(priced.lines[0].priceSnapshot).toBe(85_000);
    expect(priced.subtotal).toBe(170_000);
    expect(priced.total).toBe(176_000);
  });

  it('snapshots the chosen options onto the line', () => {
    const priced = priceCart({
      items: [{ ...base, modifiers: [{ groupName: 'Size', optionName: 'Large', priceDelta: 20_000 }] }],
      deliveryFee: 0,
      channel: Channel.OWN_STORE,
      commissionRateBps: 0,
    });
    // Renaming the option later must not rewrite this order.
    expect(priced.lines[0].modifiers).toEqual([
      { groupName: 'Size', optionName: 'Large', priceDelta: 20_000 },
    ]);
  });

  it('allows a free option', () => {
    const priced = priceCart({
      items: [{ ...base, qty: 1, modifiers: [{ groupName: 'Ice', optionName: 'No ice', priceDelta: 0 }] }],
      deliveryFee: 0,
      channel: Channel.OWN_STORE,
      commissionRateBps: 0,
    });
    expect(priced.total).toBe(60_000);
  });

  it('refuses a negative option', () => {
    expect(() =>
      priceCart({
        items: [{ ...base, modifiers: [{ groupName: 'Hack', optionName: 'Free please', priceDelta: -50_000 }] }],
        deliveryFee: 0,
        channel: Channel.OWN_STORE,
        commissionRateBps: 0,
      }),
    ).toThrow(/Negative price/);
  });

  it('charges commission on the modified price, not the base price', () => {
    const priced = priceCart({
      items: [{ ...base, qty: 1, modifiers: [{ groupName: 'Size', optionName: 'Large', priceDelta: 40_000 }] }],
      deliveryFee: 6_000,
      channel: Channel.MARKETPLACE,
      commissionRateBps: 1500,
    });
    // 15% of 1,000 (600 base + 400 upgrade), never 15% of 600.
    expect(priced.commissionAmount).toBe(15_000);
  });
});

/**
 * The free-delivery nudge. It must never promise something checkout would refuse, and it
 * must stay silent when there is nothing true to say.
 */
describe('deliveryProgress', () => {
  const paid = { id: 'city', label: 'Inside Dhaka', fee: 6_000, minOrder: 15_000, areas: [] };
  const free = { id: 'near', label: 'Dhanmondi', fee: 0, minOrder: 25_000, areas: ['Dhanmondi'] };

  it('chases the zone minimum first — below it nothing can be ordered at all', () => {
    const p = deliveryProgress(10_000, paid, [paid, free])!;
    expect(p.reward).toBe('MINIMUM_ORDER');
    expect(p.remaining).toBe(5_000);
  });

  it('then points at a reachable free-delivery zone', () => {
    const p = deliveryProgress(20_000, paid, [paid, free])!;
    expect(p.reward).toBe('FREE_DELIVERY');
    expect(p.remaining).toBe(5_000);
  });

  it('says nothing when the vendor has no free zone to reach', () => {
    expect(deliveryProgress(20_000, paid, [paid])).toBeNull();
  });

  it('reports free delivery already met rather than showing a stuck bar', () => {
    const p = deliveryProgress(30_000, free, [paid, free])!;
    expect(p.met).toBe(true);
    expect(p.remaining).toBe(0);
  });

  it('says nothing at all without a zone', () => {
    expect(deliveryProgress(50_000, null, [])).toBeNull();
  });
});

/**
 * Opening hours. The case that matters is a shift crossing midnight — "18:00–02:00" on
 * Friday must still read as open at 1am on Saturday, which a naive open<=now<=close
 * comparison gets wrong every single night.
 */
describe('isOpenAt', () => {
  const normal = [{ day: 1, open: '10:00', close: '23:00' }]; // Monday
  const overnight = [{ day: 5, open: '18:00', close: '02:00' }]; // Friday evening

  it('is open inside an ordinary shift', () => {
    expect(isOpenAt(normal, 1, 12 * 60)).toBe(true);
  });

  it('is closed before it opens and after it closes', () => {
    expect(isOpenAt(normal, 1, 9 * 60)).toBe(false);
    expect(isOpenAt(normal, 1, 23 * 60 + 1)).toBe(false);
  });

  it('is closed on a day with no shift', () => {
    expect(isOpenAt(normal, 2, 12 * 60)).toBe(false);
  });

  it('stays open past midnight into the next day', () => {
    expect(isOpenAt(overnight, 5, 20 * 60)).toBe(true);  // Friday 8pm
    expect(isOpenAt(overnight, 6, 1 * 60)).toBe(true);   // Saturday 1am — same shift
    expect(isOpenAt(overnight, 6, 3 * 60)).toBe(false);  // Saturday 3am — shift is over
  });

  it('wraps from Saturday to Sunday', () => {
    const saturdayNight = [{ day: 6, open: '20:00', close: '01:00' }];
    expect(isOpenAt(saturdayNight, 0, 30)).toBe(true); // Sunday 00:30
  });

  it('is closed when no hours are set at all', () => {
    expect(isOpenAt([], 3, 12 * 60)).toBe(false);
  });
});

/**
 * bKash amount handling.
 *
 * The API speaks decimal-string taka; everything inside this system is integer poisha.
 * A rounding slip here is a real over- or under-charge on every single order, so both
 * directions are pinned.
 */
describe('bKash amount conversion', () => {
  it('sends taka as a 2-decimal string', () => {
    expect(toTaka(90_000)).toBe('900.00');
    expect(toTaka(42_050)).toBe('420.50');
    expect(toTaka(1)).toBe('0.01');
  });

  it('reads taka back into exact poisha', () => {
    expect(fromTaka('900.00')).toBe(90_000);
    expect(fromTaka('420.50')).toBe(42_050);
    expect(fromTaka(1234.56)).toBe(123_456);
  });

  it('survives float noise rather than truncating a customer short', () => {
    // 0.1 + 0.2 style error: naive `* 100` gives 1234.5599999 -> 123455 without rounding.
    expect(fromTaka('12.345678')).toBe(1_235);
    expect(fromTaka(undefined)).toBe(0);
    expect(fromTaka('not a number')).toBe(0);
  });

  it('round-trips every amount it is given', () => {
    for (const poisha of [0, 1, 99, 100, 6_000, 42_050, 90_000, 1_000_000]) {
      expect(fromTaka(toTaka(poisha))).toBe(poisha);
    }
  });
});

/**
 * SMS sender routing. Mode A must be able to send under the vendor's own masked name —
 * a confirmation signed "FoodHub" for an order placed on kacchibhai.com reads as a scam.
 */
describe('vendor SMS credentials', () => {
  it('caps the sender ID at the operator limit', () => {
    // 11 characters is the carrier maximum for a masked sender in Bangladesh; a longer one
    // is dropped at the operator and the vendor never learns why.
    expect(smsConfigSchema.safeParse({ apiKey: 'k', senderId: 'KACCHIBHAI' }).success).toBe(true);
    expect(smsConfigSchema.safeParse({ apiKey: 'k', senderId: 'TWELVECHARSX' }).success).toBe(false);
  });

  it('allows disconnecting without credentials', () => {
    expect(smsConfigSchema.safeParse({ provider: 'NONE' }).success).toBe(true);
  });
});
