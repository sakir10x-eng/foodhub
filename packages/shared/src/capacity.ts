/**
 * Whether a rider can physically carry an order.
 *
 * A food-only platform never needs this. A grocery one does: twenty kilos of rice does not
 * go on the back of a motorcycle, and offering it to somebody on one wastes their trip and
 * the customer's evening both.
 */

/** What one vehicle can reasonably take, in kilograms, before a rider overrides it. */
export const DEFAULT_CAPACITY_KG: Record<string, number> = {
  FOOT: 8,
  BICYCLE: 12,
  MOTORCYCLE: 15,
  VAN: 150,
};

export interface WeighedLine {
  weightGrams: number;
  qty: number;
}

/**
 * The weight of an order, and how much of it we actually know.
 *
 * `unknownLines` is the important half. A shop that has weighed nothing produces a total of
 * zero, and treating that as "weightless, anybody can take it" would put a sack of rice on
 * a bicycle. So the total is reported alongside what it could not account for, and the
 * caller decides — see `canCarry`, which refuses to apply a limit it cannot trust.
 */
export function cartWeightGrams(lines: WeighedLine[]): { grams: number; unknownLines: number } {
  let grams = 0;
  let unknownLines = 0;
  for (const line of lines) {
    if (line.weightGrams > 0) grams += line.weightGrams * line.qty;
    else unknownLines++;
  }
  return { grams, unknownLines };
}

/**
 * Whether this rider should be offered this order.
 *
 * Two deliberate refusals to guess:
 *
 *   - **an order nothing is known about is allowed through.** A shop that has never
 *     weighed a product would otherwise find its entire catalogue undeliverable the day
 *     this shipped, which is a worse failure than the one being prevented.
 *   - **a partly-weighed order is judged on what is known.** Half a sack of rice is still
 *     a sack of rice; if the known part alone exceeds the vehicle, that is enough to say no.
 */
export function canCarry(
  weight: { grams: number; unknownLines: number },
  capacityKg: number,
): boolean {
  if (capacityKg <= 0) return true;
  if (weight.grams === 0) return true; // nothing known — not the same as nothing heavy
  return weight.grams <= capacityKg * 1000;
}

/** For a screen: "12.5 kg", or null when nothing in the order has ever been weighed. */
export function formatWeight(grams: number): string | null {
  if (grams <= 0) return null;
  return grams >= 1000 ? `${(grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 1)} kg` : `${grams} g`;
}
