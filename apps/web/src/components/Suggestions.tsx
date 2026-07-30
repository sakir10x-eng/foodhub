'use client';

import { useEffect, useState } from 'react';
import { formatBDT, type PublicProduct, type PublicTenant } from '@foodhub/shared';
import { clientApi } from '../lib/client';
import { useCart, useCustomer } from '../lib/cart';
import { Dish } from './Media';

/**
 * "Goes well with" — driven by what this vendor's customers actually order together.
 *
 * Only rendered once there is something in the cart: a recommendation strip on an empty
 * cart is just a second menu, and it pushes the real menu below the fold.
 */
export function GoesWellWith({ tenant }: { tenant: PublicTenant }) {
  const lines = useCart((s) => s.lines);
  const add = useCart((s) => s.add);
  const [items, setItems] = useState<PublicProduct[]>([]);

  const cartKey = lines.map((l) => l.productId).sort().join(',');

  useEffect(() => {
    if (!cartKey) {
      setItems([]);
      return;
    }
    let cancelled = false;
    clientApi<PublicProduct[]>(`/storefront/recommendations?items=${encodeURIComponent(cartKey)}`)
      .then((data) => {
        if (!cancelled) setItems(data.filter((d) => d.isAvailable).slice(0, 6));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cartKey]);

  if (items.length === 0) return null;

  return (
    <section className="border-t border-surface-line py-5">
      <h2 className="mb-3 text-[17px] font-bold tracking-tight">Goes well with</h2>
      <ul className="rail gap-3">
        {items.map((item) => (
          <li key={item.id} className="w-[136px] shrink-0">
            <div className="overflow-hidden rounded-xl bg-surface-sunk">
              <Dish image={item.image} alt={item.name} sizes="136px" className="h-24 w-full" />
            </div>
            <p className="mt-1.5 truncate text-[13px] font-semibold">{item.name}</p>
            <div className="mt-0.5 flex items-center justify-between">
              <span className="text-[13px] tabular-nums">{formatBDT(item.price)}</span>
              <button
                type="button"
                onClick={() =>
                  add(
                    { id: tenant.id, name: tenant.name, slug: tenant.slug },
                    {
                      productId: item.id,
                      name: item.name,
                      price: item.price,
                      imageUrl: item.image?.url ?? null,
                    },
                  )
                }
                aria-label={`Add ${item.name}`}
                className="grid h-7 w-7 place-items-center rounded-full border border-surface-line text-brand active:scale-90"
              >
                +
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface ReorderSuggestion {
  fromOrder: string;
  placedAt: string;
  items: { productId: string; name: string; price: number; qty: number; isAvailable: boolean }[];
  total: number;
  allAvailable: boolean;
}

/**
 * One-tap reorder for a returning customer, matched on the phone they last ordered with.
 *
 * This is the highest-leverage surface on the whole storefront: a repeat customer's
 * order is already known, so the entire flow collapses to a single tap.
 */
export function ReorderStrip({ tenant }: { tenant: PublicTenant }) {
  const saved = useCustomer((s) => s.saved);
  const add = useCart((s) => s.add);
  const clear = useCart((s) => s.clear);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!saved?.phone) return;
    clientApi<ReorderSuggestion[]>(`/storefront/reorder?phone=${encodeURIComponent(saved.phone)}`)
      .then((data) => setSuggestions(data.filter((s) => s.allAvailable).slice(0, 2)))
      .catch(() => undefined);
  }, [saved?.phone]);

  if (!mounted || suggestions.length === 0) return null;

  const reorder = (suggestion: ReorderSuggestion) => {
    // Replace rather than merge: "order this again" means exactly that basket.
    clear();
    for (const item of suggestion.items) {
      add(
        { id: tenant.id, name: tenant.name, slug: tenant.slug },
        { productId: item.productId, name: item.name, price: item.price, imageUrl: null },
        item.qty,
      );
    }
  };

  return (
    <section className="py-5">
      <h2 className="mb-1 text-[17px] font-bold tracking-tight">Order it again</h2>
      <p className="mb-3 text-[13px] text-ink-muted">Your usual, one tap away.</p>
      <ul className="space-y-2">
        {suggestions.map((suggestion) => (
          <li
            key={suggestion.fromOrder}
            className="flex items-center gap-3 rounded-2xl border border-surface-line bg-white p-3 shadow-card"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {suggestion.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}
              </p>
              <p className="text-xs text-ink-muted">
                {new Date(suggestion.placedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ·{' '}
                {formatBDT(suggestion.total)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => reorder(suggestion)}
              className="btn-brand h-10 min-h-0 shrink-0 px-4 text-sm"
            >
              Reorder
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
