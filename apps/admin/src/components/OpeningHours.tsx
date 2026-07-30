'use client';

import { useState } from 'react';
import { adminApi } from '../lib/auth';
import { Icon } from './Icon';

interface Hour { day: number; open: string; close: string }

// Bangladesh's week starts on Friday for weekends, but Sunday is day 0 everywhere in the
// code — labels here follow the calendar, and Friday is marked because it is the one day
// most kitchens run different hours.
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The opening schedule, and the switch that lets it drive the store.
 *
 * This exists because of one specific failure: a vendor forgets to close at night, orders
 * arrive at 3am, and the next morning is cancellations, refunds and one-star reviews. It
 * adds no revenue and prevents a lot of loss.
 *
 * Off by default. Automation that silently overrides a manual switch is worse than no
 * automation — a vendor who closes early for a wedding must stay closed.
 */
export function OpeningHours({
  hours: initial,
  autoOpenClose: initialAuto,
  busy,
  onSaved,
}: {
  hours: Hour[];
  autoOpenClose: boolean;
  busy: boolean;
  onSaved: () => void;
}) {
  const [hours, setHours] = useState<Hour[]>(initial);
  const [auto, setAuto] = useState(initialAuto);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty =
    JSON.stringify(hours) !== JSON.stringify(initial) || auto !== initialAuto;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await adminApi('/vendor/ops/opening-hours', {
        method: 'PUT',
        body: JSON.stringify({ hours, autoOpenClose: auto }),
      });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const forDay = (day: number) => hours.find((h) => h.day === day);

  const toggleDay = (day: number) => {
    setHours((hs) =>
      forDay(day)
        ? hs.filter((h) => h.day !== day)
        : [...hs, { day, open: '10:00', close: '23:00' }].sort((a, b) => a.day - b.day),
    );
  };

  const update = (day: number, patch: Partial<Hour>) =>
    setHours((hs) => hs.map((h) => (h.day === day ? { ...h, ...patch } : h)));

  return (
    <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-bold">Opening hours</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Turn this on and your store opens and closes itself. Forgetting to close is how
            orders arrive at 3am and turn into refunds the next morning.
          </p>
        </div>
        <button
          onClick={() => setAuto((a) => !a)}
          disabled={busy}
          aria-pressed={auto}
          aria-label="Open and close automatically"
          className={`mt-1 h-7 w-12 shrink-0 rounded-full p-0.5 transition ${auto ? 'bg-brand' : 'bg-surface-line'}`}
        >
          <span className={`block h-6 w-6 rounded-full bg-white shadow transition-transform ${auto ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <ul className="mt-4 flex flex-col gap-1.5">
        {DAYS.map((label, day) => {
          const hour = forDay(day);
          return (
            <li key={day} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleDay(day)}
                aria-pressed={Boolean(hour)}
                className={`flex w-28 shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] font-semibold transition ${
                  hour ? 'text-ink' : 'text-ink-faint'
                }`}
              >
                <span
                  className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                    hour ? 'border-brand bg-brand text-white' : 'border-surface-line'
                  }`}
                >
                  {hour && <Icon name="check" size={10} strokeWidth={3} />}
                </span>
                {label}
              </button>

              {hour ? (
                <span className="flex items-center gap-1.5 text-sm">
                  <input
                    type="time"
                    value={hour.open}
                    onChange={(e) => update(day, { open: e.target.value })}
                    className="rounded-lg border border-surface-line px-2 py-1 text-[13px] tabular-nums"
                  />
                  <span className="text-ink-faint">to</span>
                  <input
                    type="time"
                    value={hour.close}
                    onChange={(e) => update(day, { close: e.target.value })}
                    className="rounded-lg border border-surface-line px-2 py-1 text-[13px] tabular-nums"
                  />
                  {/* A closing time before the opening time is a shift that runs past
                      midnight, not a mistake — say so rather than rejecting it. */}
                  {hour.close <= hour.open && (
                    <span className="text-[11px] text-ink-faint">past midnight</span>
                  )}
                </span>
              ) : (
                <span className="text-[13px] text-ink-faint">Closed</span>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {dirty && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => { setHours(initial); setAuto(initialAuto); }}
            className="btn-ghost h-10 min-h-0 flex-1 text-sm"
          >
            Discard
          </button>
          <button onClick={save} disabled={saving} className="btn-brand h-10 min-h-0 flex-1 text-sm">
            {saving ? 'Saving…' : 'Save hours'}
          </button>
        </div>
      )}
    </section>
  );
}
