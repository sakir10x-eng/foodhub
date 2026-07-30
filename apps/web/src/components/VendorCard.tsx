'use client';

import Link from 'next/link';
import { formatBDT, formatEta, type PublicTenant } from '@foodhub/shared';
import { Dish } from './Media';
import { Icon } from './Icon';
import { useI18n, localiseDigits } from '../lib/i18n';

/** A restaurant tile in the marketplace feed. */
export function VendorCard({ vendor, priority = false }: { vendor: PublicTenant; priority?: boolean }) {
  const { t, locale } = useI18n();
  const fee = vendor.minDeliveryFee ?? 0;

  return (
    <Link
      href={`/m/r/${vendor.slug}`}
      // Prefetch on intent: by the time the tap lands, the page is usually already here.
      prefetch
      className="card block overflow-hidden transition active:scale-[.99]"
    >
      <div className="relative h-32 bg-surface-sunk">
        <Dish
          image={vendor.cover ?? vendor.logo}
          alt=""
          priority={priority}
          sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 92vw"
          className="h-full w-full"
        />
        {/* Paid placement is always labelled. An unmarked sponsored slot teaches
            customers that the ranking cannot be trusted, and the ranking is what earns
            the commission that pays for everything else. */}
        {vendor.promoted && (
          <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
            {t('vendor.sponsored')}
          </span>
        )}
        {!vendor.isOpen && (
          <div className="absolute inset-0 grid place-items-center bg-white/70">
            <span className="rounded-full bg-ink/85 px-3 py-1 text-xs font-semibold text-white">
              {t('vendor.closed')}
            </span>
          </div>
        )}
      </div>
      <div className="p-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="truncate text-[15px] font-bold">{vendor.name}</h3>
          {/* An unrated store says "New" — a 0.0 next to a star reads as "everybody
              hated it" rather than "nobody has been yet". */}
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[13px] font-semibold">
            {vendor.rating === null ? (
              <span className="text-ink-muted">{t('vendor.new')}</span>
            ) : (
              <>
                <Icon name="star" size={12} className="text-amber-500" />
                {localiseDigits(vendor.rating.toFixed(1), locale)}
              </>
            )}
          </span>
        </div>
        {vendor.tagline && <p className="mt-0.5 truncate text-[13px] text-ink-muted">{vendor.tagline}</p>}
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-muted">
          {/* The whole journey, not just the kitchen's part of it: a customer reading
              "25 min" and waiting 45 blames us for the difference. */}
          <span className="inline-flex items-center gap-1">
            <Icon name="clock" size={13} />
            {formatEta(vendor.eta, locale)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Icon name="bike" size={13} />
            {fee === 0 ? t('vendor.free') : localiseDigits(formatBDT(fee), locale)}
          </span>
          {vendor.distanceKm !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Icon name="pin" size={13} />
              {localiseDigits(vendor.distanceKm, locale)} km
            </span>
          )}
        </p>
      </div>
    </Link>
  );
}
