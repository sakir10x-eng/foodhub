import type { Poisha } from './money';

/**
 * Repricing an order after the shop could not supply all of it.
 *
 * A grocer runs out of things. Every day, in the middle of packing, and the alternative to
 * handling it is cancelling an order somebody is waiting for because one item is missing.
 *
 * **Only downwards.** A shop may remove a line or reduce a quantity; it may never add cost
 * to an order the customer already agreed to. Anything more is a new order, made with
 * their consent, not an adjustment made without it.
 */

export interface RepriceLine {
  /** What one unit was sold at, including its modifiers. Never re-read from the catalogue. */
  priceSnapshot: Poisha;
  /** What the customer ordered. */
  qty: number;
  /** What the shop can actually supply. 0 removes the line. */
  suppliedQty: number;
}

export interface RepriceResult {
  subtotal: Poisha;
  discount: Poisha;
  total: Poisha;
  /** Poisha the customer no longer owes. */
  reduction: Poisha;
  /** What the rider now collects at the door. */
  dueOnDelivery: Poisha;
  /**
   * Poisha already taken online that is now more than the order is worth.
   *
   * Only ever positive on a prepaid order that shrank below what was charged. It is
   * surfaced rather than netted off, because a refund is somebody's decision to make and
   * a number that quietly disappears is a number nobody ever gives back.
   */
  overpaid: Poisha;
}

/**
 * Reprice an order from what can actually be supplied.
 *
 * Prices come from the **line snapshots**, never from the live catalogue: the customer
 * agreed to those numbers, and a shop editing an order should not also silently apply a
 * price rise that happened since.
 *
 * The discount is scaled to the smaller subtotal and **rounded down**, so a shrinking
 * order can never yield a larger discount than the one that was offered. The delivery fee
 * does not move — the rider still rides the same distance.
 */
export function repriceOrder(
  lines: RepriceLine[],
  original: { subtotal: Poisha; discount: Poisha; deliveryFee: Poisha; advanceAmount: Poisha },
): RepriceResult {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.priceSnapshot * Math.max(0, Math.min(line.suppliedQty, line.qty)),
    0,
  );

  const discount =
    original.subtotal > 0
      ? Math.min(original.discount, Math.floor((original.discount * subtotal) / original.subtotal))
      : 0;

  const total = subtotal + original.deliveryFee - discount;
  const oldTotal = original.subtotal + original.deliveryFee - original.discount;

  // An advance bigger than the whole order is money we are holding and they are owed.
  const overpaid = Math.max(0, original.advanceAmount - total);
  const dueOnDelivery = Math.max(0, total - original.advanceAmount);

  return {
    subtotal,
    discount,
    total,
    reduction: Math.max(0, oldTotal - total),
    dueOnDelivery,
    overpaid,
  };
}

/** Whether a proposed change is one a shop is allowed to make on its own. */
export function isReductionOnly(lines: RepriceLine[]): boolean {
  return lines.every((line) => line.suppliedQty >= 0 && line.suppliedQty <= line.qty);
}
