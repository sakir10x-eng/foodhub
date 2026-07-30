'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { create } from 'zustand';
import {
  deliveryProgress,
  formatBDT,
  resolveZone,
  type PublicTenant,
} from '@foodhub/shared';
import { Icon } from './Icon';
import { lineKey, useCart } from '../lib/cart';

/** Whether the basket is showing. Kept outside the cart so opening it changes no order. */
export const useBasketSheet = create<{ isOpen: boolean; open: () => void; close: () => void }>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

/**
 * The basket, opened in place from the floating pill.
 *
 * Checkout is a separate page for good reasons — addresses, payment, an advance to
 * explain — but "what have I actually added?" is a question about the menu, asked while
 * still on the menu. Answering it here means a customer can fix a quantity and keep
 * ordering without ever leaving the list, and arrives at checkout having already agreed
 * with the total.
 *
 * The numbers shown are the ones the client can know for certain: the lines, and the
 * delivery fee of the vendor's default zone. The real fee follows the address, so it is
 * labelled as the estimate it is rather than quietly becoming a promise checkout breaks.
 */
export function CartSheet({ tenant }: { tenant?: PublicTenant }) {
  const isOpen = useBasketSheet((s) => s.isOpen);
  const close = useBasketSheet((s) => s.close);
  const lines = useCart((s) => s.lines);
  const setQty = useCart((s) => s.setQty);
  const clear = useCart((s) => s.clear);
  const fulfillment = useCart((s) => s.fulfillment);

  const count = lines.reduce((a, l) => a + l.qty, 0);
  const subtotal = lines.reduce((a, l) => a + l.price * l.qty, 0);

  const zones = tenant?.deliveryZones ?? [];
  const zone = useMemo(() => resolveZone(zones, undefined), [zones]);
  const progress = useMemo(
    () => (fulfillment === 'PICKUP' ? null : deliveryProgress(subtotal, zone, zones)),
    [fulfillment, subtotal, zone, zones],
  );

  const pickup = fulfillment === 'PICKUP';
  // A free-delivery threshold the basket has already crossed means this order pays nothing,
  // whatever the zone's list price says.
  const freeDelivery = !pickup && !!progress?.met && progress.reward === 'FREE_DELIVERY';
  const fee = pickup || freeDelivery ? 0 : zone?.fee ?? 0;
  const belowMinimum = progress && !progress.met && progress.reward === 'MINIMUM_ORDER';

  // Escape closes it, and the page behind must not scroll while it is up.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [isOpen, close]);

  // An emptied basket has nothing left to show, so it closes itself rather than sitting
  // there as an empty panel over the menu.
  useEffect(() => {
    if (isOpen && count === 0) close();
  }, [isOpen, count, close]);

  if (!isOpen || count === 0) return null;

  return (
    <>
      <div
        className="animate-fade-in fixed inset-0 z-50 bg-ink/50"
        onClick={close}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Your basket"
        className="animate-slide-up fixed inset-x-0 bottom-0 z-[60] mx-auto flex max-h-[88dvh] w-full max-w-[460px] flex-col rounded-t-2xl bg-white"
      >
        <div className="shrink-0 px-4 pb-1 pt-2">
          <span aria-hidden className="mx-auto block h-1.5 w-10 rounded-full bg-surface-edge" />
          <div className="mt-2.5 flex items-baseline justify-between">
            <h2 className="text-[18px] font-bold tracking-tight">Your basket</h2>
            <button
              type="button"
              onClick={clear}
              className="text-[12.5px] font-bold text-ink-faint transition active:scale-95"
            >
              Clear all
            </button>
          </div>
          <p className="mt-0.5 text-[12.5px] text-ink-faint">
            {pickup
              ? `Collect from ${tenant?.name ?? 'the counter'} in ${tenant?.pickupMinutes ?? 15} min`
              : `Delivered in about ${tenant?.prepMinutes ?? 30} min`}
          </p>
        </div>

        <ul className="min-h-0 flex-1 divide-y divide-surface-line overflow-y-auto px-4">
          {lines.map((line) => (
            <li key={lineKey(line)} className="flex items-center gap-3 py-2.5">
              {line.imageUrl ? (
                // The 160px derivative is the one width the upload pipeline always writes,
                // whatever the source photo's size — so this can never 404.
                <img
                  src={`${line.imageUrl}-160.webp`}
                  alt=""
                  className="h-12 w-12 shrink-0 rounded-xl object-cover"
                  loading="lazy"
                />
              ) : (
                <span className="h-12 w-12 shrink-0 rounded-xl bg-surface-sunk" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-bold leading-tight">{line.name}</p>
                {(line.modifierSummary || line.comboName) && (
                  <p className="truncate text-[11.5px] text-ink-faint">
                    {line.comboName ? `Part of ${line.comboName}` : line.modifierSummary}
                  </p>
                )}
                <p className="text-[12px] text-ink-faint tabular-nums">{formatBDT(line.price)} each</p>
              </div>
              <div className="flex shrink-0 items-center rounded-lg bg-surface-sunk">
                <button
                  type="button"
                  onClick={() => setQty(lineKey(line), line.qty - 1)}
                  aria-label={`Remove one ${line.name}`}
                  className="grid h-8 w-7 place-items-center text-[17px] font-bold text-brand"
                >
                  −
                </button>
                <span className="min-w-[18px] text-center text-[13px] font-extrabold tabular-nums">{line.qty}</span>
                <button
                  type="button"
                  onClick={() => setQty(lineKey(line), line.qty + 1)}
                  aria-label={`Add one ${line.name}`}
                  className="grid h-8 w-7 place-items-center text-[17px] font-bold text-brand"
                >
                  +
                </button>
              </div>
              <span className="w-[52px] shrink-0 text-right text-[14px] font-extrabold tabular-nums">
                {formatBDT(line.price * line.qty)}
              </span>
            </li>
          ))}
        </ul>

        <div className="shrink-0 border-t border-surface-line px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
          {progress && !progress.met && (
            <div className="mb-3">
              <p className="mb-1.5 text-[12.5px] font-semibold">
                {progress.reward === 'FREE_DELIVERY' ? (
                  <>Add <span className="text-brand">{formatBDT(progress.remaining)}</span> more for free delivery</>
                ) : (
                  <>Add <span className="text-brand">{formatBDT(progress.remaining)}</span> more to reach the minimum</>
                )}
              </p>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunk">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-300"
                  style={{ width: `${Math.round(progress.fraction * 100)}%` }}
                />
              </div>
            </div>
          )}

          <dl className="space-y-1 text-[13px] font-semibold text-ink-muted">
            <Line label="Subtotal" value={formatBDT(subtotal)} />
            {pickup ? (
              <Line label="Pickup" value="Free" good />
            ) : freeDelivery ? (
              <Line label="Delivery fee" value="Free" good />
            ) : (
              <Line label={`Delivery fee${zone ? ` · ${zone.label}` : ''}`} value={formatBDT(fee)} />
            )}
          </dl>

          <div className="mt-2.5 flex items-baseline justify-between border-t border-surface-edge pt-2.5">
            <span className="text-[16px] font-bold">Total</span>
            <span className="text-[19px] font-extrabold tabular-nums text-brand">
              {formatBDT(subtotal + fee)}
            </span>
          </div>
          {!pickup && (
            <p className="mt-1 text-[11.5px] text-ink-faint">
              Delivery is charged by area — the exact fee is confirmed once you add your address.
            </p>
          )}

          {belowMinimum ? (
            <p className="btn mt-3 w-full cursor-not-allowed bg-surface-sunk text-ink-faint">
              {formatBDT(progress.remaining)} more to order
            </p>
          ) : (
            <Link href="/checkout" prefetch onClick={close} className="btn-brand mt-3 w-full justify-between">
              <span className="flex items-center gap-2">
                <Icon name="bag" size={17} />
                Go to checkout
              </span>
              <span className="tabular-nums">{formatBDT(subtotal + fee)}</span>
            </Link>
          )}
        </div>
      </div>
    </>
  );
}

function Line({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className={good ? 'font-bold text-emerald-700' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}
