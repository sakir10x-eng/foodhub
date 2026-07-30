import { OrderStatus } from './enums';

/**
 * The order lifecycle is identical for both channels — only settlement differs.
 *
 *   PENDING -> CONFIRMED -> PREPARING -> READY -> ON_THE_WAY -> DELIVERED
 *                       \-> CANCELLED / REFUNDED
 *
 * This is the single source of truth for legal transitions; the API refuses
 * anything not listed here so a buggy client can't walk an order backwards.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['ON_THE_WAY', 'DELIVERED', 'CANCELLED'],
  ON_THE_WAY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: ['REFUNDED'],
  CANCELLED: ['REFUNDED'],
  REFUNDED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order transition ${from} -> ${to}`);
  }
}

/** Terminal states never change again and free up any held stock/quota. */
export const TERMINAL_STATUSES: readonly OrderStatus[] = ['DELIVERED', 'CANCELLED', 'REFUNDED'];

/**
 * What a CUSTOMER may cancel, which is deliberately narrower than what a vendor may.
 *
 * The line is the kitchen: once the food is being cooked, the ingredients are spent and
 * somebody has to pay for them. A vendor can still cancel later (the rider broke down,
 * the dish ran out) because they are choosing to absorb that cost; a customer cancelling
 * a half-cooked biryani is handing the vendor the bill for a decision they had no part
 * in, which is how a marketplace loses restaurants.
 */
const customerCancellable: readonly OrderStatus[] = ['PENDING', 'CONFIRMED'];
export const CUSTOMER_CANCELLABLE_STATUSES = customerCancellable;

export function canCustomerCancel(status: OrderStatus): boolean {
  return customerCancellable.includes(status);
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Statuses a vendor still has to act on — drives the admin "live queue" badge. */
export const ACTIVE_STATUSES: readonly OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'ON_THE_WAY',
];

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  PREPARING: 'Preparing',
  READY: 'Ready',
  ON_THE_WAY: 'On the way',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};

/** Customer-facing progress bar: index of the status in the happy path, or -1. */
export const HAPPY_PATH: readonly OrderStatus[] = [
  'PENDING',
  'CONFIRMED',
  'PREPARING',
  'READY',
  'ON_THE_WAY',
  'DELIVERED',
];

export function progressIndex(status: OrderStatus): number {
  return HAPPY_PATH.indexOf(status);
}
