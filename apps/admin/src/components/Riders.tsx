'use client';

import { useCallback, useEffect, useState } from 'react';
import { ORDER_STATUS_LABEL, type OrderDto } from '@foodhub/shared';
import { adminApi } from '../lib/auth';
import { Banner } from './Shell';

interface Rider {
  id: string;
  name: string;
  phone: string;
  /** False while the rider has been invited but has not answered yet. */
  approved: boolean;
  /** Withheld until they accept — see the note by the invited row below. */
  token: string | null;
}

/**
 * Who is carrying what, and the link that puts a rider's own deliveries on their phone.
 *
 * This lives on the Orders page rather than in Settings because assigning a rider is
 * something you do twenty times a shift with a bag in your other hand, and settings are
 * something you touch once. Only orders that have left the kitchen are listed — a rider
 * assigned to something still being cooked is a decision that will be wrong by the time
 * it matters.
 *
 * A rider is a person, not this shop's staff: the same one may carry for the grocer next
 * door on the same trip. So adding somebody who already rides elsewhere sends them an
 * invitation rather than hiring them outright, and this screen has to show that waiting
 * state honestly instead of pretending the rider is available.
 */
export function Riders({ storefrontUrl }: { storefrontUrl: string }) {
  const [riders, setRiders] = useState<Rider[]>([]);
  const [queue, setQueue] = useState<OrderDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '' });
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, q] = await Promise.all([
        adminApi<Rider[]>('/vendor/ops/riders'),
        adminApi<OrderDto[]>('/vendor/orders/queue'),
      ]);
      setRiders(r);
      setQueue(q.filter((o) => o.status === 'READY' || o.status === 'ON_THE_WAY'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    // The kitchen screen is left open all evening; without this the list of deliveries
    // is whatever it was when the page was opened.
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const assign = async (orderId: string, riderId: string) => {
    setBusy(true);
    try {
      await adminApi(`/vendor/ops/orders/${orderId}/rider`, {
        method: 'POST',
        body: JSON.stringify({ riderId: riderId || null }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addRider = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await adminApi('/vendor/ops/riders', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', phone: '' });
      setAdding(false);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (rider: Rider) => {
    if (!rider.token) return;
    try {
      await navigator.clipboard.writeText(`${storefrontUrl}/rider?token=${rider.token}`);
      setCopied(rider.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard refused (an insecure origin, usually).
    }
  };

  const assignable = riders.filter((r) => r.approved);

  return (
    <section className="mb-6 rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-bold">Delivery</h2>
        <button type="button" onClick={() => setAdding((v) => !v)} className="text-sm font-semibold text-brand">
          {adding ? 'Cancel' : '+ Add rider'}
        </button>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      {adding && (
        <form onSubmit={addRider} className="mb-4 flex flex-wrap gap-2">
          <input
            className="field flex-1" placeholder="Rider name" required minLength={2}
            value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="field flex-1" placeholder="01XXXXXXXXX" required inputMode="numeric"
            value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
          <button className="btn-brand h-11 min-h-0 px-4 text-sm" disabled={busy}>Add</button>
        </form>
      )}

      {riders.length === 0 ? (
        <p className="text-sm text-ink-muted">
          No riders yet. Add one and send them their link — they do not need an account.
        </p>
      ) : (
        <ul className="mb-4 space-y-2">
          {riders.map((rider) => (
            <li key={rider.id} className="flex items-center gap-3 rounded-xl bg-surface-sunk px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{rider.name}</p>
                <p className="truncate text-xs text-ink-faint">{rider.phone}</p>
              </div>
              {rider.approved ? (
                /* The link IS the rider's login, so it is copied rather than displayed in
                   full — a token read aloud across a counter is a token everybody has. */
                <button
                  type="button"
                  onClick={() => copy(rider)}
                  className="shrink-0 rounded-full border border-surface-line px-3 py-1.5 text-xs font-semibold text-ink-muted transition hover:border-brand hover:text-brand"
                >
                  {copied === rider.id ? 'Copied ✓' : 'Copy link'}
                </button>
              ) : (
                /* No link here, and that is the feature. This rider already delivers for
                   somebody else, and their link opens a sheet with that shop's customers
                   on it — so it is theirs to hand over, not ours. */
                <span className="shrink-0 rounded-full bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700">
                  Invited — waiting for them
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Out for delivery</h3>
      {queue.length === 0 ? (
        <p className="text-sm text-ink-muted">Nothing waiting on a rider.</p>
      ) : (
        <ul className="space-y-2">
          {queue.map((order) => (
            <li key={order.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-surface-line px-3 py-2">
              <span className="font-mono text-sm font-semibold">{order.code}</span>
              <span className="text-xs text-ink-faint">{ORDER_STATUS_LABEL[order.status]}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">
                {order.deliveryAddress.area || order.deliveryAddress.addressLine}
              </span>
              {/* Only riders who have accepted are offered: an invited one cannot be
                  assigned yet, and listing them would produce a refusal at the counter. */}
              <select
                className="field h-10 min-h-0 w-40 py-0 text-sm"
                disabled={busy || assignable.length === 0}
                value={order.riderId ?? ''}
                onChange={(e) => assign(order.id, e.target.value)}
              >
                <option value="">Unassigned</option>
                {assignable.map((rider) => (
                  <option key={rider.id} value={rider.id}>{rider.name}</option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
