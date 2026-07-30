'use client';

import { useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { Icon } from './Icon';

interface Policy {
  codEnabled: boolean;
  advancePercent: number;
  advanceThreshold: number;
}

/**
 * How much a customer has to pay before the kitchen starts.
 *
 * This exists because of a specific, expensive problem: a hoax cash-on-delivery order
 * costs the vendor the food and the rider's time, and there is nothing to claw back. An
 * advance makes the hoax cost the customer something instead. It is a real money control,
 * so the UI is explicit about the trade-off — every taka demanded up front is also a
 * customer who might not finish the order.
 */
export function PaymentPolicy({
  policy,
  busy,
  gatewayConfigured,
  onSave,
}: {
  policy: Policy;
  busy: boolean;
  /** An advance can only be demanded if there is something to collect it with. */
  gatewayConfigured: boolean;
  onSave: (patch: Partial<Policy>) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(policy.advanceThreshold / 100);

  const apply = async (patch: Partial<Policy>) => {
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const OPTIONS: { value: number; title: string; note: string }[] = [
    { value: 0, title: 'No advance', note: 'Pay online or on delivery — customer chooses' },
    { value: 50, title: 'Half up front', note: 'Rider collects the rest at the door' },
    { value: 100, title: 'Full payment', note: 'Nothing to collect on delivery' },
  ];

  return (
    <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
          <Icon name="shield" size={18} />
        </span>
        <div>
          <h2 className="font-bold">Payment rules</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Fake orders cost you the food and the delivery. Asking for money up front makes
            a hoax cost the customer something too.
          </p>
        </div>
      </div>

      {/*
        Stated before the options rather than as an error after the click: an advance
        closes cash on delivery, so turning one on without a gateway would leave the
        storefront unable to accept anything at all.
      */}
      {!gatewayConfigured && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-surface-sunk px-3 py-2.5 text-[13px] text-ink-muted">
          <Icon name="lock" size={15} className="mt-0.5 shrink-0" />
          <span>
            Connect your payment gateway below to require an advance — there is no way to
            collect one until then.
          </span>
        </p>
      )}

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((opt) => {
          const on = policy.advancePercent === opt.value;
          const locked = opt.value > 0 && !gatewayConfigured;
          return (
            <button
              key={opt.value}
              onClick={() => !on && apply({ advancePercent: opt.value })}
              disabled={busy || locked}
              aria-pressed={on}
              title={locked ? 'Connect a payment gateway first' : undefined}
              className={`rounded-xl border p-3 text-left transition disabled:cursor-not-allowed ${
                locked
                  ? 'border-surface-line opacity-45'
                  : on
                    ? 'border-brand bg-brand/6 ring-2 ring-brand/15'
                    : 'border-surface-line hover:border-ink-faint'
              }`}
            >
              <span className="flex items-center justify-between">
                <span className="text-lg font-extrabold tabular-nums">
                  {opt.value === 0 ? '—' : `${opt.value}%`}
                </span>
                {on && <Icon name="check" size={16} className="text-brand" strokeWidth={2.6} />}
              </span>
              <span className="mt-1 block text-[13px] font-bold leading-tight">{opt.title}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">{opt.note}</span>
            </button>
          );
        })}
      </div>

      {policy.advancePercent > 0 && (
        <label className="mt-3 block rounded-xl bg-surface-sunk p-3">
          <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Only for orders above
          </span>
          <span className="flex items-center gap-2">
            <span className="flex items-center rounded-xl border border-surface-line bg-white focus-within:border-brand">
              <span className="pl-3 text-sm text-ink-faint">৳</span>
              <input
                type="number"
                min={0}
                className="h-9 w-24 bg-transparent px-2 text-sm tabular-nums outline-none"
                value={threshold}
                onChange={(e) => setThreshold(Math.max(0, Number(e.target.value || 0)))}
                onBlur={() =>
                  Math.round(threshold * 100) !== policy.advanceThreshold &&
                  apply({ advanceThreshold: Math.round(threshold * 100) })
                }
              />
            </span>
            <span className="text-xs text-ink-muted">
              {threshold === 0
                ? 'Applies to every order'
                : `Smaller orders stay ${policy.codEnabled ? 'cash on delivery' : 'online payment'}`}
            </span>
          </span>
        </label>
      )}

      {/*
        The two settings interact, so the consequence is spelled out rather than left for
        the vendor to work out from two separate controls.
      */}
      <div className="mt-3 flex items-start justify-between gap-4 rounded-xl border border-surface-line p-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-bold">
            <Icon name="cash" size={15} className="text-ink-muted" />
            Cash on delivery
          </p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {!policy.codEnabled
              ? 'Off — every order must be paid online before you cook.'
              : policy.advancePercent === 100
                ? 'Unavailable while full payment is required.'
                : policy.advancePercent === 50
                  ? 'The rider collects the remaining half in cash.'
                  : 'Customers can pay the rider in cash.'}
          </p>
        </div>
        <Toggle
          on={policy.codEnabled && policy.advancePercent !== 100}
          disabled={busy || policy.advancePercent === 100}
          onToggle={() => apply({ codEnabled: !policy.codEnabled })}
        />
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-faint">
        <Icon name="alert" size={14} className="mt-px shrink-0" />
        <span>
          {policy.advancePercent === 0 ? (
            <>No advance is required, so a no-show costs you the whole order.</>
          ) : (
            <>
              A {formatBDT(100_000)} order will need{' '}
              <b className="text-ink">{formatBDT((100_000 * policy.advancePercent) / 100)}</b> paid
              online{policy.advanceThreshold > 0 && <> (orders under {formatBDT(policy.advanceThreshold)} are exempt)</>}.
            </>
          )}
        </span>
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}

function Toggle({ on, disabled, onToggle }: { on: boolean; disabled: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={on}
      aria-label="Cash on delivery"
      className={`mt-1 h-7 w-12 shrink-0 rounded-full p-0.5 transition disabled:opacity-40 ${
        on ? 'bg-brand' : 'bg-surface-line'
      }`}
    >
      <span
        className={`block h-6 w-6 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`}
      />
    </button>
  );
}
