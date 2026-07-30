'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { estimateEta, formatBDT, formatEta, type OfferDto, type PublicTenant } from '@foodhub/shared';
import { Dish } from './Media';
import { Icon } from './Icon';
import { OfferStrip } from './Offers';
import { FulfillmentToggle } from './FulfillmentToggle';
import { useCart } from '../lib/cart';
import { toast } from './Toast';

/**
 * The banner shared by a vendor's own storefront and their marketplace page.
 *
 * One component for both channels on purpose: the whole product premise is that a vendor
 * maintains one catalog and one identity, and two hand-maintained headers would drift
 * until "the same restaurant" looked like two businesses. The only difference the caller
 * gets is the back link, which exists on the marketplace and has nowhere to go on a
 * storefront that IS the site.
 *
 * Everything above the menu answers one of four questions a customer asks before they
 * order anything: is it open, is it any good, how long, how much to get it here. They are
 * laid out in that order and nothing else is allowed in front of them.
 */
export function StoreHeader({
  tenant,
  offers,
  backHref,
}: {
  tenant: PublicTenant;
  offers?: OfferDto[];
  backHref?: string;
}) {
  return (
    <header className="relative">
      <div className="relative h-[186px] overflow-hidden bg-surface-sunk frame:rounded-t-3xl">
        <Dish image={tenant.cover} alt="" priority sizes="480px" className="h-full w-full" />
        {/*
          Two stacked bands rather than one overlay: the top darkens just enough to keep
          the round buttons legible over a pale sky, the bottom anchors the info card's
          edge against a bright food photo. A single mid-strength scrim muddies the
          photograph without solving either end.
        */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/20" />
        <TopActions tenant={tenant} backHref={backHref} />
      </div>

      <div className="relative z-10 -mt-[26px] mx-3 rounded-2xl bg-white px-4 pb-1 pt-4 shadow-card">
        <div className="flex items-start gap-3">
          <div className="h-[52px] w-[52px] shrink-0 overflow-hidden rounded-xl border border-surface-line bg-white">
            <Dish image={tenant.logo} alt={tenant.name} sizes="52px" className="h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[22px] font-extrabold leading-tight tracking-tight">{tenant.name}</h1>
            {tenant.tagline && (
              <p className="mt-0.5 line-clamp-1 text-[12.5px] text-ink-faint">{tenant.tagline}</p>
            )}
          </div>
          <span
            className={`mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-extrabold ${
              tenant.isOpen ? 'bg-emerald-50 text-emerald-700' : 'bg-surface-sunk text-ink-muted'
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${tenant.isOpen ? 'bg-emerald-600' : 'bg-ink-faint'}`} />
            {tenant.isOpen ? 'Open' : 'Closed'}
          </span>
        </div>

        <RatingRow tenant={tenant} />
        <StatGrid tenant={tenant} />
        <AdvanceNote percent={tenant.payment?.advancePercent ?? 0} />
      </div>

      <div className="px-3">
        <FulfillmentToggle tenant={tenant} />
        <OfferStrip offers={offers ?? []} />
      </div>
    </header>
  );
}

/**
 * The round buttons over the cover photo.
 *
 * Only actions that do something real live here. Sharing uses the OS sheet where there is
 * one and falls back to the clipboard, which is the whole of how a Dhaka restaurant link
 * actually travels — pasted into WhatsApp.
 */
function TopActions({ tenant, backHref }: { tenant: PublicTenant; backHref?: string }) {
  const share = async () => {
    const url = window.location.href;
    const data = { title: tenant.name, text: tenant.tagline || `Order from ${tenant.name}`, url };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      // A cancelled share sheet throws exactly like a failed one. Neither is an error the
      // customer needs told about, so both end here quietly.
    }
  };

  return (
    <div className="absolute inset-x-0 top-0 z-[5] flex items-start justify-between p-3">
      {backHref ? (
        <Link href={backHref} aria-label="Back" className="glass-btn">
          <Icon name="back" size={18} strokeWidth={2.1} />
        </Link>
      ) : (
        <span />
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => {
            const box = document.getElementById('menu-search');
            box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            box?.focus({ preventScroll: true });
          }}
          aria-label="Search the menu"
          className="glass-btn"
        >
          <Icon name="search" size={18} strokeWidth={2.1} />
        </button>
        <button type="button" onClick={share} aria-label={`Share ${tenant.name}`} className="glass-btn">
          <Icon name="share" size={17} strokeWidth={2.1} />
        </button>
      </div>
    </div>
  );
}

/**
 * The earned score, or "New".
 *
 * A store with no ratings shows no number at all. Rendering "0.0 ★" for a restaurant
 * nobody has ordered from yet would be worse than saying nothing — it reads as a bad
 * score rather than an absent one.
 */
function RatingRow({ tenant }: { tenant: PublicTenant }) {
  if (tenant.rating == null || !tenant.ratingCount) {
    return (
      <p className="mt-3 flex items-center gap-2 text-[13px]">
        <span className="rounded-lg bg-surface-sunk px-2 py-0.5 text-[12px] font-bold text-ink-muted">New</span>
        <span className="text-ink-faint">No ratings yet</span>
      </p>
    );
  }

  const value = tenant.rating;

  return (
    <a
      href="#reviews"
      className="mt-3 flex items-center gap-2 rounded-lg py-0.5 text-[13px] transition active:scale-[.99]"
    >
      <span className="flex gap-px" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <Star key={i} index={i} fill={Math.max(0, Math.min(1, value - i))} />
        ))}
      </span>
      <b className="text-[14px] tabular-nums">{value.toFixed(1)}</b>
      <span className="text-ink-faint">
        ({tenant.ratingCount} {tenant.ratingCount === 1 ? 'rating' : 'ratings'})
      </span>
      <span className="font-bold text-brand">See reviews ›</span>
    </a>
  );
}

/**
 * One star, filled by fraction.
 *
 * A 4.7 draws four solid stars and one 70% full, because rounding it up to five is the
 * cheapest possible way to make a rating meaningless.
 */
function Star({ fill, index }: { fill: number; index: number }) {
  const d = 'm12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8L12 4Z';
  // Unique per star: five gradients sharing one id is invalid HTML, and a browser is
  // entitled to resolve every reference to whichever it saw first.
  const id = `star-${index}`;
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id={id}>
          <stop offset={`${fill * 100}%`} stopColor="#F5A623" />
          <stop offset={`${fill * 100}%`} stopColor="#E2E2E8" />
        </linearGradient>
      </defs>
      <path d={d} fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * Said here, not saved for the payment step.
 *
 * A customer who builds a ৳1,200 basket and only then learns half is due up front feels
 * ambushed, and abandons. Stating it beside the delivery fee costs a few visitors at the
 * top of the page and saves the rest of them at the bottom.
 */
function AdvanceNote({ percent }: { percent: number }) {
  if (percent <= 0) return null;
  return (
    <p className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11.5px] font-semibold text-amber-800">
      <Icon name="lock" size={12} strokeWidth={2.2} className="shrink-0" />
      {percent === 100 ? 'Prepaid orders only' : `${percent}% of the total is paid online up front`}
    </p>
  );
}

/**
 * Wait, cost, place — the three numbers that decide whether an order happens.
 *
 * They change with the fulfilment choice directly below them, so collecting from the
 * counter visibly zeroes the fee and shortens the wait instead of burying that discovery
 * three screens later at checkout.
 */
function StatGrid({ tenant }: { tenant: PublicTenant }) {
  const fulfillment = useCart((s) => s.fulfillment);
  const [mounted, setMounted] = useState(false);
  // The choice is restored from localStorage, so the first client render must match the
  // server's — which knows nothing about it — before the real value is allowed in.
  useEffect(() => setMounted(true), []);

  const pickup = mounted && fulfillment === 'PICKUP';
  const range = tenant.deliveryFeeRange ?? { min: tenant.minDeliveryFee ?? 0, max: tenant.minDeliveryFee ?? 0 };
  const place = placeOf(tenant.address);
  const maps = tenant.lat != null && tenant.lng != null ? `https://maps.google.com/?q=${tenant.lat},${tenant.lng}` : null;

  return (
    <dl className="mt-3.5 flex divide-x divide-surface-edge rounded-xl border border-surface-edge">
      <Stat
        icon="clock"
        // The whole wait, kitchen plus rider — the number on the card and the number
        // here have to be the same promise, or one of them is a lie.
        value={formatEta(
          estimateEta({
            prepMinutes: tenant.prepMinutes,
            deliveryMinutes: tenant.deliveryMinutes ?? 20,
            pickupMinutes: tenant.pickupMinutes,
            fulfillment: pickup ? 'PICKUP' : 'DELIVERY',
            distanceKm: tenant.distanceKm,
          }),
        )}
        label={pickup ? 'Ready for pickup' : 'Delivery time'}
      />
      <Stat
        icon="bike"
        value={pickup ? 'Free' : feeLabel(range)}
        label={pickup ? 'From the counter' : 'Delivery fee'}
      />
      <Stat
        icon="pin"
        value={tenant.distanceKm != null ? `${tenant.distanceKm.toFixed(1)} km` : place.value}
        label={place.label}
        href={maps}
      />
    </dl>
  );
}

function Stat({
  icon, value, label, href,
}: {
  icon: 'clock' | 'bike' | 'pin';
  value: string;
  label: string;
  href?: string | null;
}) {
  const body = (
    <>
      <dd className="flex items-center justify-center gap-1 text-[13.5px] font-extrabold">
        <Icon name={icon} size={13} className="text-brand" strokeWidth={2} />
        <span className="truncate">{value}</span>
      </dd>
      <dt className="mt-0.5 truncate text-[10.5px] font-semibold text-ink-faint">{label}</dt>
    </>
  );
  return (
    <div className="min-w-0 flex-1 px-1.5 py-2.5 text-center">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="block">
          {body}
        </a>
      ) : (
        body
      )}
    </div>
  );
}

/**
 * "Shop 3, Mirpur 10 Circle, Dhaka" → Mirpur 10 Circle, in Dhaka.
 *
 * The neighbourhood is what a customer recognises; the house number is not. When the
 * address is a single line there is nothing to split, so it is shown whole rather than
 * truncated into something that reads like a mistake.
 */
function placeOf(address: string): { value: string; label: string } {
  const parts = (address ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { value: 'Map', label: 'Location' };
  if (parts.length === 1) return { value: parts[0], label: 'Location' };
  return { value: parts[parts.length - 2], label: parts[parts.length - 1] };
}

/**
 * What delivery actually costs.
 *
 * Both ends of the range, because a vendor whose zones run ৳0–120 was previously showing
 * "Free delivery" to every customer on the strength of one free neighbourhood. That is
 * the kind of number a customer only checks once — at checkout, when it has changed.
 */
function feeLabel(range: { min: number; max: number }): string {
  if (range.max === 0) return 'Free';
  if (range.min === range.max) return formatBDT(range.min);
  if (range.min === 0) return `Free–${formatBDT(range.max)}`;
  return `${formatBDT(range.min)}–${formatBDT(range.max)}`;
}
