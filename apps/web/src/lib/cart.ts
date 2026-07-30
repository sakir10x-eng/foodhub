'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Fulfillment } from '@foodhub/shared';

export interface CartLine {
  productId: string;
  name: string;
  /** Unit price INCLUDING the chosen options — what the row shows and the server re-derives. */
  price: number;
  qty: number;
  imageUrl: string | null;
  /** Chosen modifier option IDs. The server re-prices from these; the client never sends amounts. */
  optionIds?: string[];
  /** "Large · Extra cheese", for the cart row. */
  modifierSummary?: string;
  /** Set when the line came from a bundle. */
  comboName?: string;
}

/**
 * Two cart rows are the same line only if they are the same product with the same choices.
 * Without this, a large pizza and a small one collapse into one row at whichever price
 * happened to be added first.
 */
function sameLine(a: CartLine, b: { productId: string; optionIds?: string[]; comboName?: string }): boolean {
  if (a.productId !== b.productId) return false;
  if ((a.comboName ?? '') !== (b.comboName ?? '')) return false;
  const x = [...(a.optionIds ?? [])].sort().join(',');
  const y = [...(b.optionIds ?? [])].sort().join(',');
  return x === y;
}

interface CartState {
  /** One vendor per cart. Adding from another vendor replaces it — see `add()`. */
  tenantId: string | null;
  tenantName: string;
  tenantSlug: string;
  /**
   * Delivery or collection. Chosen on the menu page and carried to checkout, because the
   * fee it decides is shown next to the food, long before the payment screen.
   */
  fulfillment: Fulfillment;
  lines: CartLine[];
  add: (tenant: { id: string; name: string; slug: string }, line: Omit<CartLine, 'qty'>, qty?: number) => 'added' | 'replaced';
  /** `key` is the cart row's identity — see `lineKey`. */
  setQty: (key: string, qty: number) => void;
  setFulfillment: (value: Fulfillment) => void;
  clear: () => void;
  count: () => number;
  subtotal: () => number;
}

/**
 * Optimistic, local-first cart.
 *
 * Every mutation lands in the UI immediately and is persisted to localStorage; the
 * server never sees the cart until checkout, where it re-prices everything from the
 * database. That keeps add-to-cart at zero latency without trusting client prices.
 */
export const useCart = create<CartState>()(
  persist(
    (set, get) => ({
      tenantId: null,
      tenantName: '',
      tenantSlug: '',
      fulfillment: 'DELIVERY',
      lines: [],

      add(tenant, line, qty = 1) {
        const state = get();
        // Single-vendor carts, like real Foodpanda. A multi-vendor cart would force
        // split payments and split delivery, which is out of scope for v1.
        const replacing = state.tenantId !== null && state.tenantId !== tenant.id;

        const lines = replacing ? [] : [...state.lines];
        const existing = lines.find((l) => sameLine(l, line));
        if (existing) existing.qty = Math.min(50, existing.qty + qty);
        else lines.push({ ...line, qty });

        set({
          tenantId: tenant.id,
          tenantName: tenant.name,
          tenantSlug: tenant.slug,
          lines,
          // A different vendor may not offer pickup at all, and checkout would refuse a
          // mode the customer never chose for this store.
          ...(replacing ? { fulfillment: 'DELIVERY' as Fulfillment } : {}),
        });
        return replacing ? 'replaced' : 'added';
      },

      setFulfillment(value) {
        set({ fulfillment: value });
      },

      setQty(key, qty) {
        const lines = get()
          .lines.map((l) => (lineKey(l) === key ? { ...l, qty: Math.max(0, Math.min(50, qty)) } : l))
          .filter((l) => l.qty > 0);
        set({
          lines,
          ...(lines.length === 0
            ? { tenantId: null, tenantName: '', tenantSlug: '', fulfillment: 'DELIVERY' as Fulfillment }
            : {}),
        });
      },

      clear() {
        set({ lines: [], tenantId: null, tenantName: '', tenantSlug: '', fulfillment: 'DELIVERY' });
      },

      count() {
        return get().lines.reduce((a, l) => a + l.qty, 0);
      },

      subtotal() {
        return get().lines.reduce((a, l) => a + l.price * l.qty, 0);
      },
    }),
    { name: 'foodhub.cart' },
  ),
);

/** Saved for a ≤3-tap repeat order. */
export interface SavedCustomer {
  name: string;
  phone: string;
  addressLine: string;
  area: string;
  city: string;
  note: string;
  /**
   * Where the pin was dropped. Saved with the rest of the address so a returning customer
   * does not have to find their roof on a map twice.
   */
  lat?: number | null;
  lng?: number | null;
}

export const useCustomer = create<{
  saved: SavedCustomer | null;
  save: (c: SavedCustomer) => void;
}>()(
  persist(
    (set) => ({ saved: null, save: (saved) => set({ saved }) }),
    { name: 'foodhub.customer' },
  ),
);

/** Stable identity for a cart row: the product plus exactly what was chosen on it. */
export function lineKey(line: CartLine): string {
  return [line.productId, [...(line.optionIds ?? [])].sort().join('+'), line.comboName ?? ''].join('|');
}
