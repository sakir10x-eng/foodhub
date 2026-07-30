/**
 * Enum values are duplicated here (rather than imported from @prisma/client) so the
 * web/admin bundles never pull in Prisma. Keep in sync with apps/api/prisma/schema.prisma.
 */

export const Channel = {
  OWN_STORE: 'OWN_STORE',
  MARKETPLACE: 'MARKETPLACE',
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const OrderStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  PREPARING: 'PREPARING',
  READY: 'READY',
  ON_THE_WAY: 'ON_THE_WAY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Delivery or collection. Chosen per order, offered only where the vendor allows it. */
export const Fulfillment = {
  DELIVERY: 'DELIVERY',
  PICKUP: 'PICKUP',
} as const;
export type Fulfillment = (typeof Fulfillment)[keyof typeof Fulfillment];

export const PaymentStatus = {
  UNPAID: 'UNPAID',
  /** An advance was taken online; the rider still collects the remainder. */
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  PAID: 'PAID',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const Role = {
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  VENDOR_OWNER: 'VENDOR_OWNER',
  VENDOR_STAFF: 'VENDOR_STAFF',
  CUSTOMER: 'CUSTOMER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const Plan = {
  FREE: 'FREE',
  BASIC: 'BASIC',
  PRO: 'PRO',
} as const;
export type Plan = (typeof Plan)[keyof typeof Plan];

export const PlanStatus = {
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

export const SslStatus = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED',
} as const;
export type SslStatus = (typeof SslStatus)[keyof typeof SslStatus];

export const LedgerType = {
  CUSTOMER_PAYMENT: 'CUSTOMER_PAYMENT',
  COMMISSION: 'COMMISSION',
  VENDOR_PAYABLE: 'VENDOR_PAYABLE',
  SETTLEMENT: 'SETTLEMENT',
  REFUND: 'REFUND',
} as const;
export type LedgerType = (typeof LedgerType)[keyof typeof LedgerType];

export const SettlementStatus = {
  PENDING: 'PENDING',
  PAID: 'PAID',
} as const;
export type SettlementStatus = (typeof SettlementStatus)[keyof typeof SettlementStatus];

export const InvoiceStatus = {
  PAID: 'PAID',
  UNPAID: 'UNPAID',
  OVERDUE: 'OVERDUE',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

