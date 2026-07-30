/**
 * How long the food will take, as a range the customer can plan around.
 *
 * Every number here comes from something the vendor actually maintains — kitchen prep
 * time, their own delivery-leg estimate, and (when the customer has dropped a pin) the
 * real distance. Nothing is invented: a made-up "20 min" on a vendor who takes an hour
 * is a one-star review and a refund, which costs far more than showing an honest 55.
 *
 * A RANGE, not a single number, because a single number is a promise. "30–40 min" is
 * kept by arriving at 38; "30 min" is broken by the same delivery.
 */

/** Dhaka traffic on a bike, door to door, including the pickup wait at the counter. */
const RIDER_SPEED_KMH = 18;

/** How wide the quoted window is. Ten minutes reads as a real estimate, not a guess. */
const DELIVERY_SPREAD_MIN = 10;

/** A counter collection has no rider leg, so its window can be tighter. */
const PICKUP_SPREAD_MIN = 5;

export interface EtaInput {
  /** Minutes the kitchen needs before the food is ready to leave. */
  prepMinutes: number;
  /** The vendor's own estimate of the rider leg, used when we have no distance. */
  deliveryMinutes: number;
  /** Minutes until a collection order is ready at the counter. */
  pickupMinutes?: number;
  fulfillment?: 'DELIVERY' | 'PICKUP';
  /** Straight-line km from the vendor to the customer's pin, when one was dropped. */
  distanceKm?: number | null;
}

export interface EtaRange {
  min: number;
  max: number;
}

/** Rounds up to the nearest 5 so the quote reads like an estimate, not a calculation. */
function toFive(minutes: number): number {
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

/**
 * The rider leg. With a pin we can do better than the vendor's flat guess for a
 * far-away customer — but never WORSE than it for a near one, because the vendor's own
 * number already includes the things distance cannot see: the wait at the counter, the
 * lift, the gate, the phone call from the front desk.
 */
function riderMinutes(deliveryMinutes: number, distanceKm?: number | null): number {
  if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm <= 0) {
    return deliveryMinutes;
  }
  // Straight-line distance under-states a real road route; 1.3 is the usual correction
  // for a dense city grid.
  const roadKm = distanceKm * 1.3;
  return Math.max(deliveryMinutes, (roadKm / RIDER_SPEED_KMH) * 60);
}

export function estimateEta(input: EtaInput): EtaRange {
  if (input.fulfillment === 'PICKUP') {
    const ready = toFive(input.pickupMinutes ?? input.prepMinutes);
    return { min: ready, max: ready + PICKUP_SPREAD_MIN };
  }

  const total = toFive(input.prepMinutes + riderMinutes(input.deliveryMinutes, input.distanceKm));
  return { min: total, max: total + DELIVERY_SPREAD_MIN };
}

/** "30–40 min" — the one place the range is turned into words, so it reads the same everywhere. */
export function formatEta(eta: EtaRange, locale: 'en' | 'bn' = 'en'): string {
  if (locale === 'bn') {
    const bn = (n: number) => String(n).replace(/\d/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);
    return `${bn(eta.min)}–${bn(eta.max)} মিনিট`;
  }
  return `${eta.min}–${eta.max} min`;
}

/**
 * When the order should be at the door, given when the kitchen accepted it. Used by the
 * tracker, which knows the real clock and not just a duration.
 */
export function etaClock(from: Date, eta: EtaRange): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(from.getTime() + eta.min * 60_000),
    latest: new Date(from.getTime() + eta.max * 60_000),
  };
}
