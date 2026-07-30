import type { PublicTenant, ReviewDto } from '@foodhub/shared';
import { Icon } from './Icon';

/**
 * What other customers said, under the menu.
 *
 * Only reviews that came with words are shown — the bare score is already in the header,
 * and a column of anonymous 5-star rows adds no information while pushing the menu up
 * out of reach. A store with a score but no written reviews renders the summary alone.
 */
export function Reviews({ tenant, reviews }: { tenant: PublicTenant; reviews: ReviewDto[] }) {
  if (tenant.rating == null || !tenant.ratingCount) return null;

  return (
    <section id="reviews" className="mt-8 scroll-mt-16 border-t border-surface-line pt-6">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[17px] font-bold tracking-tight">Ratings</h2>
        <span className="text-[13px] text-ink-faint">
          from {tenant.ratingCount} delivered {tenant.ratingCount === 1 ? 'order' : 'orders'}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3 rounded-2xl bg-surface-sunk p-4">
        <span className="text-3xl font-extrabold tabular-nums leading-none">
          {tenant.rating.toFixed(1)}
        </span>
        <span>
          <Stars value={tenant.rating} />
          <span className="mt-0.5 block text-[12px] text-ink-faint">
            {/* Stated because it is the whole trust argument: you cannot rate a store
                you never ordered from. */}
            Only customers who received an order can rate.
          </span>
        </span>
      </div>

      {reviews.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {reviews.map((r) => (
            <li key={r.id} className="rounded-2xl border border-surface-line p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-bold">{r.authorName}</span>
                <Stars value={r.rating} size={13} />
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-ink-muted">{r.comment}</p>
              {/* The reply is what turns a two-star review into evidence that somebody is
                  paying attention — new customers read it more carefully than the stars. */}
              {r.reply && (
                <p className="mt-2 border-l-2 border-brand/25 pl-2.5 text-[12.5px] leading-relaxed text-ink-muted">
                  <span className="font-bold text-ink">{tenant.name} replied</span>
                  <span className="mt-0.5 block">{r.reply}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Five stars with the earned ones filled. Rounded to the nearest half at display size. */
export function Stars({ value, size = 15 }: { value: number; size?: number }) {
  const filled = Math.round(value);
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Icon
          key={i}
          name="star"
          size={size}
          strokeWidth={2}
          className={i <= filled ? 'text-amber-500' : 'text-surface-line'}
        />
      ))}
    </span>
  );
}
