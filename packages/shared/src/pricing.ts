import { Channel } from './enums';
import { applyBps, assertPoisha, Poisha } from './money';

/** One chosen option, snapshotted onto the order line. */
export interface ChosenModifier {
  groupName: string;
  optionName: string;
  priceDelta: Poisha;
}

export interface PricedLine {
  productId: string;
  /** Name + price captured at order time so later menu edits never rewrite history. */
  nameSnapshot: string;
  /**
   * The unit price actually charged: the product's price plus every chosen option.
   * Stored per unit, not per line, so a quantity change never needs the modifiers re-read.
   */
  priceSnapshot: Poisha;
  qty: number;
  lineTotal: Poisha;
  /** Snapshotted alongside the price — a renamed topping must not rewrite an old order. */
  modifiers: ChosenModifier[];
  /** Set when the line came from a bundle rather than a single item. */
  comboName?: string;
}

export interface CartPricing {
  lines: PricedLine[];
  subtotal: Poisha;
  deliveryFee: Poisha;
  discount: Poisha;
  total: Poisha;
  /** Marketplace only. Always 0 for own_store — see priceCart(). */
  commissionAmount: Poisha;
  vendorPayable: Poisha;
}

export interface PriceCartInput {
  items: {
    productId: string;
    name: string;
    price: Poisha;
    qty: number;
    /** Already validated against the product's groups by the caller. */
    modifiers?: ChosenModifier[];
    comboName?: string;
  }[];
  deliveryFee: Poisha;
  discount?: Poisha;
  channel: Channel;
  /** Basis points. Ignored entirely on own_store. */
  commissionRateBps: number;
  /** Gateway fee we absorb on marketplace orders, in bps of total. */
  gatewayFeeBps?: number;
}

export const MAX_QTY_PER_LINE = 50;

/**
 * The single pricing function for BOTH channels.
 *
 * The channel discriminator is load-bearing: commission is only ever computed for
 * MARKETPLACE orders. On OWN_STORE the money never passes through us, so charging a
 * per-order commission would be unenforceable — that model is fixed-fee subscription
 * only. Do not "unify" these branches.
 */
export function priceCart(input: PriceCartInput): CartPricing {
  const { items, channel, commissionRateBps, gatewayFeeBps = 0 } = input;

  if (items.length === 0) throw new Error('Cart is empty');

  const lines: PricedLine[] = items.map((item) => {
    assertPoisha(item.price, `price of ${item.name}`);
    if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_QTY_PER_LINE) {
      throw new Error(`Invalid quantity ${item.qty} for ${item.name}`);
    }
    if (item.price < 0) throw new Error(`Negative price for ${item.name}`);

    const modifiers = item.modifiers ?? [];
    let unitPrice = item.price;
    for (const m of modifiers) {
      assertPoisha(m.priceDelta, `price of ${m.optionName}`);
      // Options may be free but never negative: a discount hidden inside a topping is
      // invisible to coupons, commission and the ledger, and would let a crafted request
      // price an order below zero.
      if (m.priceDelta < 0) throw new Error(`Negative price for option ${m.optionName}`);
      unitPrice += m.priceDelta;
    }

    return {
      productId: item.productId,
      nameSnapshot: item.name,
      priceSnapshot: unitPrice,
      qty: item.qty,
      lineTotal: unitPrice * item.qty,
      modifiers,
      ...(item.comboName ? { comboName: item.comboName } : {}),
    };
  });

  const subtotal = lines.reduce((acc, l) => acc + l.lineTotal, 0);

  const deliveryFee = input.deliveryFee;
  assertPoisha(deliveryFee, 'deliveryFee');
  if (deliveryFee < 0) throw new Error('deliveryFee cannot be negative');

  // A discount may never exceed the subtotal — that would make the order a payout.
  const requestedDiscount = input.discount ?? 0;
  assertPoisha(requestedDiscount, 'discount');
  if (requestedDiscount < 0) throw new Error('discount cannot be negative');
  const discount = Math.min(requestedDiscount, subtotal);

  const total = subtotal + deliveryFee - discount;
  if (total < 0) throw new Error('Order total cannot be negative');

  // Commission is charged on the goods value only, never on the delivery fee —
  // the vendor is the one paying the rider in v1 (self-delivery).
  const commissionAmount =
    channel === Channel.MARKETPLACE ? applyBps(subtotal - discount, commissionRateBps) : 0;

  const gatewayFee = channel === Channel.MARKETPLACE ? applyBps(total, gatewayFeeBps) : 0;

  const vendorPayable = channel === Channel.MARKETPLACE ? total - commissionAmount - gatewayFee : 0;

  return { lines, subtotal, deliveryFee, discount, total, commissionAmount, vendorPayable };
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface DeliveryZone {
  id: string;
  label: string;
  fee: Poisha;
  /** Order subtotal below this is refused for the zone. 0 = no minimum. */
  minOrder: Poisha;
  /** Free-text area names matched case-insensitively against the customer's area. */
  areas: string[];
  /**
   * How far the rider goes, drawn on a map by the vendor.
   *
   * A circle (`center` + `radiusKm`) covers the ordinary case — "we deliver 3km around the
   * shop" — in one drag. `polygon` is for the cases a circle gets wrong: a river, a
   * highway, one side of a road. When both are set the polygon wins, because a vendor who
   * took the trouble to draw a boundary meant it.
   *
   * A zone with NEITHER matches by area name exactly as before. That is what makes this
   * additive: existing vendors keep working, and a vendor who draws even one boundary is
   * choosing to be strict about it.
   */
  center?: GeoPoint | null;
  radiusKm?: number | null;
  polygon?: GeoPoint[] | null;
}

/** Whether this zone is drawn on a map at all. */
export function zoneHasShape(zone: DeliveryZone): boolean {
  return (zone.polygon?.length ?? 0) >= 3 || (!!zone.center && (zone.radiusKm ?? 0) > 0);
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in kilometres. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Ray casting, in degrees.
 *
 * A delivery area is at most a few kilometres across, so treating lat/lng as a flat plane
 * costs far less accuracy than the width of the road the customer lives on. Points
 * exactly on an edge count as inside — the alternative is a house on the boundary being
 * refused by a rounding error.
 */
export function pointInPolygon(point: GeoPoint, polygon: GeoPoint[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const straddles = a.lat > point.lat !== b.lat > point.lat;
    if (!straddles) continue;
    const x = ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (point.lng <= x) inside = !inside;
  }
  return inside;
}

/** Whether a delivery point falls inside this zone's drawn area. */
export function zoneContains(zone: DeliveryZone, point: GeoPoint): boolean {
  if (zone.polygon && zone.polygon.length >= 3) return pointInPolygon(point, zone.polygon);
  if (zone.center && (zone.radiusKm ?? 0) > 0) return distanceKm(zone.center, point) <= zone.radiusKm!;
  return false;
}

export interface ZoneMatch {
  zone: DeliveryZone | null;
  /**
   * True when the vendor has drawn boundaries, the customer is outside all of them, and
   * no catch-all zone exists to take the order. The storefront turns this into "we don't
   * deliver to your area yet" instead of a fee.
   */
  outsideServiceArea: boolean;
}

/**
 * Which zone a delivery falls in, given everything we know about where it is going.
 *
 * Order matters and is deliberate:
 *   1. A drawn boundary containing the point wins — it is the most specific thing the
 *      vendor has said, and the cheapest such zone wins so overlapping circles never
 *      charge a customer for the vendor's own sloppiness.
 *   2. Otherwise the shapeless zones behave exactly as they always have, matched by area
 *      name, and act as the catch-all.
 *   3. If the vendor has drawn boundaries and left no catch-all, being outside them is a
 *      refusal, not a fallback to some other zone's price.
 *
 * A vendor with no drawn boundaries at all is unaffected by any of this.
 */
export function matchZone(
  zones: DeliveryZone[],
  opts: { area?: string; point?: GeoPoint | null },
): ZoneMatch {
  if (zones.length === 0) return { zone: null, outsideServiceArea: false };

  const shaped = zones.filter(zoneHasShape);
  const plain = zones.filter((z) => !zoneHasShape(z));

  if (shaped.length > 0 && opts.point) {
    const hits = shaped.filter((z) => zoneContains(z, opts.point!));
    if (hits.length > 0) {
      return { zone: hits.reduce((best, z) => (z.fee < best.fee ? z : best)), outsideServiceArea: false };
    }
  }

  const fallback = resolveZone(plain, opts.area);
  if (fallback) return { zone: fallback, outsideServiceArea: false };

  // Every zone is drawn and the point is in none of them — or there is no point to test
  // against, which for a vendor who delivers by map is the same answer.
  if (shaped.length > 0) return { zone: null, outsideServiceArea: true };
  return { zone: null, outsideServiceArea: false };
}

/** Whether any of these zones is drawn on a map — i.e. whether a pin is required. */
export function requiresLocation(zones: DeliveryZone[]): boolean {
  return zones.some(zoneHasShape) && !zones.some((z) => !zoneHasShape(z));
}

export const DEFAULT_ZONES: DeliveryZone[] = [
  { id: 'inside', label: 'Inside city', fee: 6000, minOrder: 0, areas: [] },
  { id: 'outside', label: 'Outside city', fee: 12000, minOrder: 0, areas: [] },
];

export function resolveZone(zones: DeliveryZone[], area: string | undefined): DeliveryZone | null {
  if (zones.length === 0) return null;
  if (area) {
    const needle = area.trim().toLowerCase();
    const hit = zones.find((z) => z.areas.some((a) => a.trim().toLowerCase() === needle));
    if (hit) return hit;
  }
  return zones[0];
}

/* ─────────────────────────────────────────────── payment policy ─── */

export interface PaymentPolicy {
  /** Whether cash-on-delivery may be chosen at all. */
  codEnabled: boolean;
  /** 0 = no advance, 50 = half up front, 100 = full prepayment. */
  advancePercent: number;
  /** Only demand an advance above this subtotal. 0 = always. */
  advanceThreshold: Poisha;
}

export interface PaymentSplit {
  /** Charged online before the kitchen starts. */
  advanceAmount: Poisha;
  /** Collected by the rider on arrival. */
  dueOnDelivery: Poisha;
  /** True when the order cannot be placed as plain cash-on-delivery. */
  advanceRequired: boolean;
  /** Whether COD is offerable for this specific order. */
  codAllowed: boolean;
}

export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  codEnabled: true,
  advancePercent: 0,
  advanceThreshold: 0,
};

/**
 * How an order's money is split between "pay now" and "pay the rider".
 *
 * Fake cash-on-delivery orders are a real cost in Bangladeshi food delivery — the
 * kitchen cooks, the rider rides, nobody answers the door. A vendor can require an
 * advance so a hoax costs the customer something.
 *
 * The advance is computed on the TOTAL, not the subtotal: the delivery fee is the part
 * the vendor is most exposed on if nobody takes the order, so it must be covered by the
 * prepayment too. The threshold, however, is checked against the subtotal — a vendor
 * setting "advance above ৳2000" means two thousand taka of food, not food plus delivery.
 */
export function splitPayment(
  total: Poisha,
  subtotal: Poisha,
  policy: PaymentPolicy,
): PaymentSplit {
  assertPoisha(total, 'total');

  const percent = Math.min(100, Math.max(0, Math.round(policy.advancePercent ?? 0)));
  const applies = percent > 0 && subtotal >= (policy.advanceThreshold ?? 0);

  if (!applies) {
    return {
      advanceAmount: 0,
      dueOnDelivery: total,
      advanceRequired: false,
      // With no advance rule, COD is available only if the vendor accepts it at all.
      codAllowed: policy.codEnabled,
    };
  }

  // Round the advance UP to the nearest poisha so the remainder can never exceed
  // what the policy intended the customer to owe on the doorstep.
  const advanceAmount = Math.min(total, Math.ceil((total * percent) / 100));

  return {
    advanceAmount,
    dueOnDelivery: total - advanceAmount,
    advanceRequired: true,
    // A partial advance still ends in a cash handover, but the order can never be
    // placed as pure COD — something must be paid online first.
    codAllowed: false,
  };
}

/* ─────────────────────────────────────────── free-delivery progress ─── */

export interface DeliveryProgress {
  /** How much more the customer must spend. 0 once the threshold is met. */
  remaining: Poisha;
  /** 0–1, for a progress bar. */
  fraction: number;
  /** What is unlocked at the threshold. */
  reward: 'FREE_DELIVERY' | 'MINIMUM_ORDER';
  threshold: Poisha;
  met: boolean;
}

/**
 * "Spend ৳120 more for free delivery."
 *
 * The cheapest upsell in the product: no new data, no new screen, just a sentence in the
 * cart bar computed from the zones the vendor already configured. It answers two different
 * questions with the same bar — how far off the zone's *minimum* the customer is (below
 * which they cannot order at all), and how far off a *free-delivery* zone.
 *
 * Returns null when there is nothing true to say, which matters: a progress bar that never
 * completes is worse than no bar, and inventing a threshold to have something to show is
 * how a storefront starts lying about its own prices.
 */
export function deliveryProgress(
  subtotal: Poisha,
  zone: DeliveryZone | null,
  zones: DeliveryZone[],
): DeliveryProgress | null {
  if (!zone) return null;

  // A minimum the customer has not reached blocks the order outright, so it always wins
  // over the softer free-delivery nudge.
  if (zone.minOrder > 0 && subtotal < zone.minOrder) {
    return {
      remaining: zone.minOrder - subtotal,
      fraction: Math.min(1, subtotal / zone.minOrder),
      reward: 'MINIMUM_ORDER',
      threshold: zone.minOrder,
      met: false,
    };
  }

  // Free delivery is only worth mentioning where it is actually reachable: a zone with a
  // zero fee whose own minimum the customer could still cross.
  if (zone.fee > 0) {
    const free = zones
      .filter((z) => z.fee === 0 && z.minOrder > subtotal)
      .sort((a, b) => a.minOrder - b.minOrder)[0];
    if (free) {
      return {
        remaining: free.minOrder - subtotal,
        fraction: free.minOrder === 0 ? 1 : Math.min(1, subtotal / free.minOrder),
        reward: 'FREE_DELIVERY',
        threshold: free.minOrder,
        met: false,
      };
    }
    return null;
  }

  // Already in a free zone and past its minimum — say so rather than showing a bar.
  return { remaining: 0, fraction: 1, reward: 'FREE_DELIVERY', threshold: zone.minOrder, met: true };
}
