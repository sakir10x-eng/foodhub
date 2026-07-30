'use client';

import { useEffect, useState } from 'react';
import type { PublicTenant } from '@foodhub/shared';
import { Icon } from './Icon';
import { useCart } from '../lib/cart';

/**
 * Delivery or pickup, chosen before the menu rather than at checkout.
 *
 * It sits here because it changes the two numbers directly above it — the wait and the
 * fee — and a customer deciding to collect wants to see the fee disappear immediately,
 * not discover it three screens later. The choice lives in the cart store, so it survives
 * the walk from menu to checkout and is submitted with the order.
 *
 * The selected side is a pill that slides rather than two buttons that swap colour: the
 * movement is what makes it read as one control with a position, which is the difference
 * between a customer knowing they chose pickup and merely having tapped it.
 *
 * Renders nothing when the vendor has no shopfront: a two-option control with one real
 * option is just a disabled button asking to be pressed.
 */
export function FulfillmentToggle({ tenant }: { tenant: PublicTenant }) {
  const fulfillment = useCart((s) => s.fulfillment);
  const setFulfillment = useCart((s) => s.setFulfillment);
  const [mounted, setMounted] = useState(false);
  // Restored from localStorage after hydration; until then the server's assumption
  // (delivery) is what is on screen, and disagreeing with it would be a hydration error.
  useEffect(() => setMounted(true), []);

  if (!tenant.pickupEnabled) return null;

  const pickup = mounted && fulfillment === 'PICKUP';

  return (
    /*
     * The track is deliberately darker than the page behind it. At `surface-sunk` it was
     * two values off the background and the whole control read as absent — a segmented
     * switch only works if you can see the groove the pill slides in.
     */
    <div
      role="radiogroup"
      aria-label="How would you like your order?"
      className="relative mt-3.5 flex rounded-xl border border-surface-edge bg-surface-edge p-1"
    >
      <span
        aria-hidden
        className={`absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-[10px] bg-white shadow-card transition-transform duration-300 ease-[cubic-bezier(.3,.9,.3,1.1)] ${
          pickup ? 'translate-x-full' : 'translate-x-0'
        }`}
      />
      <Option on={!pickup} onClick={() => setFulfillment('DELIVERY')} icon="bike" label="Delivery" />
      <Option on={pickup} onClick={() => setFulfillment('PICKUP')} icon="bag" label="Pickup" />
    </div>
  );
}

function Option({
  on, onClick, icon, label,
}: {
  on: boolean; onClick: () => void; icon: 'bike' | 'bag'; label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`relative z-10 flex flex-1 items-center justify-center gap-2 rounded-[10px] py-2.5 text-[14px] font-bold transition-colors ${
        on ? 'text-brand' : 'text-ink-faint'
      }`}
    >
      <Icon name={icon} size={17} strokeWidth={2} />
      {label}
    </button>
  );
}
