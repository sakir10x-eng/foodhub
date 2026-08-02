'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { adminApi } from '../lib/auth';
import { Banner } from './Shell';

interface RiderMoneyRow {
  id: string;
  name: string;
  phone: string;
  onDuty: boolean;
  /** The shop's money this rider is carrying, across every shop they work for. */
  cash: number;
  /** What they are owed. */
  earnings: number;
}

/**
 * End-of-day cash reconciliation.
 *
 * The one screen that has to exist before this platform can take a cash order it is
 * serious about: at close of business somebody is carrying several thousand taka of the
 * shop's money, and both sides need to be looking at the same number.
 *
 * Handing in cash is typed rather than confirmed with one tap, and short amounts are
 * accepted. A rider who hands over ৳4,000 of ৳4,500 leaves ৳500 still showing as held —
 * not written off, not deducted from their pay, just visibly still owed for a person to
 * settle. The alternative, a button that says "all handed in", is a button that makes the
 * screen agree with itself and disagree with the money.
 */
export function RiderMoney() {
  const [rows, setRows] = useState<RiderMoneyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [amount, setAmount] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await adminApi<RiderMoneyRow[]>('/vendor/rider-money'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const takeCash = async (riderId: string) => {
    // Taka on screen, poisha on the wire — the only place this conversion happens.
    const taka = Number(amount);
    if (!Number.isFinite(taka) || taka <= 0) return;

    setBusy(true);
    try {
      await adminApi(`/vendor/rider-money/${riderId}/deposit`, {
        method: 'POST',
        body: JSON.stringify({ amount: Math.round(taka * 100) }),
      });
      setOpen(null);
      setAmount('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const holding = rows.reduce((sum, r) => sum + r.cash, 0);
  if (rows.length === 0) return null;

  return (
    <section className="mb-6 rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="font-bold">Rider cash</h2>
        <span className="text-sm text-ink-muted">
          {holding > 0 ? `${formatBDT(holding)} out with riders` : 'All cash is in'}
        </span>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <ul className="space-y-2">
        {rows.map((rider) => (
          <li key={rider.id} className="rounded-xl border border-surface-line px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {rider.name}
                  {rider.onDuty && <span className="ml-2 text-xs font-bold text-emerald-700">on duty</span>}
                </p>
                <p className="truncate text-xs text-ink-faint">{rider.phone}</p>
              </div>

              <div className="text-right">
                <p className="text-xs text-ink-faint">Holding</p>
                <p className={`text-sm font-bold tabular-nums ${rider.cash > 0 ? 'text-amber-700' : ''}`}>
                  {formatBDT(rider.cash)}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-ink-faint">Owed</p>
                <p className="text-sm font-bold tabular-nums">{formatBDT(rider.earnings)}</p>
              </div>

              {rider.cash > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(open === rider.id ? null : rider.id);
                    setAmount(String(rider.cash / 100));
                  }}
                  className="shrink-0 rounded-full border border-surface-line px-3 py-1.5 text-xs font-semibold text-ink-muted transition hover:border-brand hover:text-brand"
                >
                  Take cash
                </button>
              )}
            </div>

            {open === rider.id && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  className="field h-10 min-h-0 w-32 py-0 text-sm"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Taka"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => takeCash(rider.id)}
                  className="btn-brand h-10 min-h-0 px-4 text-sm"
                >
                  Received
                </button>
                <p className="text-xs text-ink-faint">
                  Enter what was actually handed over. Anything short stays showing as held.
                </p>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
