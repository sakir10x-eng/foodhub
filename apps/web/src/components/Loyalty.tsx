'use client';

import { useEffect, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { clientApi } from '../lib/client';

export interface LoyaltyState {
  redeemPoints: number;
  useWallet: boolean;
  /** What the current selection is worth, for the running total in the checkout bar. */
  discount: number;
}

interface Balance {
  points: number;
  wallet: number;
  tier: string;
  redeemableValue: number;
  config: { enabled: boolean; pointValue: number; minRedeemPoints: number };
}

/**
 * Points and store credit at checkout.
 *
 * Renders nothing at all unless the vendor runs a programme AND this customer has
 * something to spend — an empty "0 points" panel is friction for the 90% of customers
 * it doesn't apply to.
 *
 * The discount shown here is a preview. The server re-quotes and re-checks the balance
 * inside the order transaction, so a stale panel can't overspend.
 */
export function LoyaltyPanel({
  phone,
  subtotal,
  value,
  onChange,
}: {
  phone: string;
  subtotal: number;
  value: LoyaltyState;
  onChange: (next: LoyaltyState) => void;
}) {
  const [balance, setBalance] = useState<Balance | null>(null);

  useEffect(() => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 11) {
      setBalance(null);
      onChange({ redeemPoints: 0, useWallet: false, discount: 0 });
      return;
    }
    let cancelled = false;
    // Debounced: the phone field fires this on every keystroke otherwise.
    const timer = setTimeout(() => {
      clientApi<Balance>(`/storefront/loyalty/balance?phone=${encodeURIComponent(phone)}`)
        .then((b) => {
          if (!cancelled) setBalance(b.config.enabled ? b : null);
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone]);

  if (!balance) return null;

  const canRedeemPoints = balance.points >= balance.config.minRedeemPoints;
  const hasWallet = balance.wallet > 0;
  if (!canRedeemPoints && !hasWallet) return null;

  const recompute = (redeemPoints: number, useWallet: boolean) => {
    // Mirror the server's cap: rewards may cover the goods value, never the delivery fee.
    const pointsValue = Math.min(redeemPoints * balance.config.pointValue, subtotal);
    const usablePoints = Math.floor(pointsValue / balance.config.pointValue);
    const afterPoints = subtotal - usablePoints * balance.config.pointValue;
    const walletValue = useWallet ? Math.min(balance.wallet, afterPoints) : 0;
    onChange({
      redeemPoints: usablePoints,
      useWallet,
      discount: usablePoints * balance.config.pointValue + walletValue,
    });
  };

  return (
    <section className="border-b-8 border-surface-sunk px-4 py-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-faint">Your rewards</h2>
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">
          {balance.tier}
        </span>
      </div>

      <div className="space-y-2">
        {canRedeemPoints && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-surface-line p-3">
            <input
              type="checkbox"
              className="mt-1 accent-[rgb(var(--brand))]"
              checked={value.redeemPoints > 0}
              onChange={(e) => recompute(e.target.checked ? balance.points : 0, value.useWallet)}
            />
            <span className="text-sm">
              <span className="block font-semibold">
                Use {balance.points} points ({formatBDT(balance.redeemableValue)} off)
              </span>
              <span className="block text-xs text-ink-muted">
                Earned from your previous orders here.
              </span>
            </span>
          </label>
        )}

        {hasWallet && (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-surface-line p-3">
            <input
              type="checkbox"
              className="mt-1 accent-[rgb(var(--brand))]"
              checked={value.useWallet}
              onChange={(e) => recompute(value.redeemPoints, e.target.checked)}
            />
            <span className="text-sm">
              <span className="block font-semibold">
                Use store credit ({formatBDT(balance.wallet)} available)
              </span>
              <span className="block text-xs text-ink-muted">Applied after points.</span>
            </span>
          </label>
        )}
      </div>
    </section>
  );
}
