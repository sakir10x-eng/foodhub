'use client';

import type { OfferDto } from '@foodhub/shared';
import { Icon, type IconName } from './Icon';
import { toast } from './Toast';

/**
 * The offer strip that sits directly under the store's details.
 *
 * Every card here is derived server-side from live data — a coupon row, the loyalty
 * settings, a zero-fee zone — so the strip cannot advertise something checkout would then
 * refuse. Coupon cards copy their code on tap, because the alternative is a customer
 * memorising a string while scrolling a menu.
 *
 * It scrolls horizontally with snap points rather than wrapping: a vendor running three
 * promotions should not push the menu below the fold on a phone.
 */
export function OfferStrip({ offers }: { offers: OfferDto[] }) {
  if (offers.length === 0) return null;

  return (
    <section aria-label="Offers" className="mt-4">
      <ul className="rail">
        {offers.map((offer) => (
          <li key={offer.id} className="w-[222px] shrink-0 snap-start">
            <OfferCard offer={offer} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Three looks, one per kind of promise.
 *
 * A coupon wears the vendor's own colour because it is the vendor's money; free delivery
 * is green because that is the colour it is on every receipt; loyalty is the graphite card
 * so a rewards balance never competes with a live discount for attention.
 */
const LOOK: Record<OfferDto['kind'], { icon: IconName; className: string }> = {
  COUPON: { icon: 'tag', className: 'from-brand to-brand/80' },
  FREE_DELIVERY: { icon: 'bike', className: 'from-emerald-600 to-emerald-500' },
  LOYALTY: { icon: 'gift', className: 'from-ink to-ink/75' },
};

function OfferCard({ offer }: { offer: OfferDto }) {
  const look = LOOK[offer.kind];
  const ending = endingSoon(offer.expiresAt);

  const copy = async () => {
    if (!offer.code) return;
    try {
      await navigator.clipboard.writeText(offer.code);
      toast(`Code ${offer.code} copied`);
    } catch {
      // Clipboard is blocked in some in-app browsers. The code is on the card either way,
      // so a failure here is silent rather than an error the customer cannot act on.
    }
  };

  const body = (
    <>
      <span className="absolute right-3 top-3 rounded-md bg-white/25 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide">
        {offer.code ? 'Code' : ending ?? 'Auto'}
      </span>
      <Icon name={look.icon} size={20} strokeWidth={2} />
      <span className="mt-1.5 block pr-12 text-[14px] font-extrabold leading-tight">{offer.title}</span>
      <span className="mt-0.5 block text-[11.5px] leading-snug text-white/85">{offer.subtitle}</span>
      {offer.code && (
        <span className="mt-2 flex items-center gap-1.5">
          <span className="rounded-md border border-dashed border-white/50 bg-white/15 px-2 py-0.5 font-mono text-[12px] font-bold tracking-wider">
            {offer.code}
          </span>
          <span className="text-[10.5px] font-semibold text-white/80">Tap to copy</span>
        </span>
      )}
    </>
  );

  const className = `relative block h-full w-full overflow-hidden rounded-xl bg-gradient-to-br p-3 text-left text-white ${look.className}`;

  return offer.code ? (
    <button type="button" onClick={copy} className={`${className} transition active:scale-[.98]`}>
      {body}
    </button>
  ) : (
    <div className={className}>{body}</div>
  );
}

/**
 * Only shouts about the deadline when it is genuinely close. "Ends in 40 days" is noise
 * that trains customers to ignore the badge that matters.
 */
function endingSoon(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  const hours = ms / 3_600_000;
  if (hours <= 24) return hours < 1 ? 'Last hour' : `${Math.round(hours)}h left`;
  const days = Math.ceil(hours / 24);
  return days <= 3 ? `${days} days left` : null;
}
