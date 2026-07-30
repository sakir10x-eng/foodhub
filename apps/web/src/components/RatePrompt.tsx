'use client';

import { useState } from 'react';
import type { OrderDto } from '@foodhub/shared';
import { clientApi, ApiError } from '../lib/client';
import { Icon } from './Icon';

/**
 * The rating prompt, shown on the order tracker once the food has arrived.
 *
 * This is the only way a rating can be created, which is the entire integrity model: the
 * customer is already holding an order code and the phone that placed it, and the server
 * re-checks both. There is no "rate this restaurant" button anywhere else, so a score
 * cannot exist without a delivered order behind it.
 *
 * It renders nothing until DELIVERED — asking someone to rate food they have not eaten
 * produces noise, not signal.
 */
export function RatePrompt({ order, phone }: { order: OrderDto; phone: string }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(order.reviewRating != null);
  /** productId → thumbs up (true) / down (false). Absent means no opinion given. */
  const [dishes, setDishes] = useState<Record<string, boolean>>({});

  if (order.status !== 'DELIVERED') return null;

  if (done) {
    return (
      <section className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
        <span className="mx-auto grid h-9 w-9 place-items-center rounded-full bg-emerald-500 text-white">
          <Icon name="check" size={18} strokeWidth={2.6} />
        </span>
        <p className="mt-2 text-sm font-bold text-emerald-900">Thanks for rating this order.</p>
      </section>
    );
  }

  const submit = async () => {
    if (rating === 0) return;
    setBusy(true);
    setError(null);
    try {
      await clientApi('/orders/review', {
        method: 'POST',
        body: JSON.stringify({
          code: order.code,
          phone,
          rating,
          comment,
          dishes: Object.entries(dishes).map(([productId, up]) => ({ productId, up })),
        }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send your rating. Please try again.');
      setBusy(false);
    }
  };

  const shown = hover || rating;

  /*
   * One row per distinct dish this order contained.
   *
   * Deduplicated because a basket can hold the same item as two lines (different options,
   * or part of a combo) and nobody wants to grade "Malai Cha" three times. Lines with no
   * productId are historical items whose product has since been deleted — there is
   * nothing left to attach a verdict to.
   */
  const dishItems = order.items.filter(
    (item, i) => item.productId && order.items.findIndex((o) => o.productId === item.productId) === i,
  );

  /** Tapping the verdict you already gave clears it — a misfire should be undoable. */
  const toggleDish = (productId: string, up: boolean) =>
    setDishes((prev) => {
      const next = { ...prev };
      if (next[productId] === up) delete next[productId];
      else next[productId] = up;
      return next;
    });

  return (
    <section className="mt-5 rounded-2xl border border-surface-line p-4">
      <h2 className="text-[15px] font-bold">How was it?</h2>
      <p className="mt-0.5 text-[13px] text-ink-muted">
        Your rating is shown on {order.tenantName ?? 'the restaurant'}&rsquo;s page.
      </p>

      <div className="mt-3 flex items-center gap-1" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            aria-label={`${i} star${i > 1 ? 's' : ''}`}
            aria-pressed={rating === i}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setRating(i)}
            className="p-1 transition active:scale-90"
          >
            <Icon
              name="star"
              size={30}
              strokeWidth={1.8}
              className={i <= shown ? 'text-amber-500' : 'text-surface-line'}
            />
          </button>
        ))}
        {rating > 0 && (
          <span className="ml-1 text-[13px] font-semibold text-ink-muted">{LABELS[rating]}</span>
        )}
      </div>

      {/* Dish by dish, once the order as a whole has a score.
          A five-star evening does not tell the kitchen the borhani was flat, and a
          two-star one does not tell them the kacchi was the best thing on the street.
          Optional by design — nobody should be made to grade six items to leave a rating. */}
      {rating > 0 && dishItems.length > 0 && (
        <fieldset className="mt-4 rounded-xl bg-surface-sunk p-3">
          <legend className="px-1 text-[12.5px] font-bold text-ink-muted">
            Anything stand out? (optional)
          </legend>
          <ul className="mt-1 space-y-1.5">
            {dishItems.map((item) => (
              <li key={item.productId} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">
                  {item.nameSnapshot}
                </span>
                <Verdict
                  up
                  active={dishes[item.productId!] === true}
                  onClick={() => toggleDish(item.productId!, true)}
                  label={`Liked ${item.nameSnapshot}`}
                />
                <Verdict
                  up={false}
                  active={dishes[item.productId!] === false}
                  onClick={() => toggleDish(item.productId!, false)}
                  label={`Did not like ${item.nameSnapshot}`}
                />
              </li>
            ))}
          </ul>
        </fieldset>
      )}

      {/* The comment box only appears once a score is picked: an empty textarea above an
          untouched star row reads as a form to fill in, and most people just leave. */}
      {rating > 0 && (
        <>
          <textarea
            className="field mt-3"
            rows={2}
            maxLength={500}
            placeholder="Anything you'd tell a friend? (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          {error && (
            <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <button onClick={submit} disabled={busy} className="btn-brand mt-3 w-full">
            {busy ? 'Sending…' : 'Send rating'}
          </button>
        </>
      )}
    </section>
  );
}

/** One thumb. Pressed state carries colour AND fill, so it does not rely on hue alone. */
function Verdict({
  up, active, onClick, label,
}: {
  up: boolean; active: boolean; onClick: () => void; label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border text-[15px] transition active:scale-90 ${
        active
          ? up
            ? 'border-emerald-600 bg-emerald-600 text-white'
            : 'border-ink bg-ink text-white'
          : 'border-surface-edge bg-white'
      }`}
    >
      {up ? '👍' : '👎'}
    </button>
  );
}

const LABELS: Record<number, string> = {
  1: 'Bad',
  2: 'Poor',
  3: 'Okay',
  4: 'Good',
  5: 'Excellent',
};
