'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { adminApi } from '../../../lib/auth';
import { PageHeader, PlatformShell } from '../../../components/Shell';

interface HubRider {
  id: string;
  name: string;
  phone: string;
  onDuty: boolean;
  dutySince: string | null;
  vehicle: string;
  capacityKg: number;
  lat: number | null;
  lng: number | null;
  locationAt: string | null;
  areas: string[];
  shops: string[];
  openAlerts: number;
  cash: number;
  earnings: number;
}

interface Unclaimed {
  waiting: number;
  unmatchable: number;
  orders: {
    code: string;
    store: string;
    area: string;
    status: string;
    waitingMinutes: number;
    matchable: boolean;
  }[];
}

/**
 * The delivery operation seen whole.
 *
 * Each shop's own panel shows its corner of this. Nobody else sees that two villages have
 * five riders between them and a third has none, or that an order has been sitting
 * unclaimed for forty minutes because its address matches nobody's patch.
 *
 * Unclaimed work is at the top and everything else is below it, because it is the only
 * number here that represents a customer currently being let down.
 */
export default function HubPage() {
  const [riders, setRiders] = useState<HubRider[]>([]);
  const [unclaimed, setUnclaimed] = useState<Unclaimed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, u] = await Promise.all([
        adminApi<HubRider[]>('/platform/riders'),
        adminApi<Unclaimed>('/platform/unclaimed'),
      ]);
      setRiders(r);
      setUnclaimed(u);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const onDuty = riders.filter((r) => r.onDuty);
  const cashOut = riders.reduce((sum, r) => sum + r.cash, 0);

  /** How old a position is. A pin with no age beside it is one somebody will believe. */
  const fixAge = (iso: string | null) => {
    if (!iso) return null;
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
    return mins < 1 ? 'just now' : `${mins} min ago`;
  };

  return (
    <PlatformShell>
      <PageHeader title="Delivery" />

      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Waiting for a rider"
          value={String(unclaimed?.waiting ?? 0)}
          tone={(unclaimed?.waiting ?? 0) > 0 ? 'warn' : 'plain'}
        />
        <Stat
          label="Address matches nobody"
          value={String(unclaimed?.unmatchable ?? 0)}
          tone={(unclaimed?.unmatchable ?? 0) > 0 ? 'warn' : 'plain'}
        />
        <Stat label="On duty" value={`${onDuty.length} of ${riders.length}`} />
        <Stat label="Cash out with riders" value={formatBDT(cashOut)} tone={cashOut > 0 ? 'warn' : 'plain'} />
      </div>

      {unclaimed && unclaimed.orders.length > 0 && (
        <section className="mb-6 rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <h2 className="mb-3 font-bold">Nobody has taken these</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-ink-faint">
                <tr>
                  <th className="pb-2 pr-3">Order</th>
                  <th className="pb-2 pr-3">Shop</th>
                  <th className="pb-2 pr-3">Area</th>
                  <th className="pb-2 pr-3">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {unclaimed.orders.map((order) => (
                  <tr key={order.code} className="border-t border-surface-line">
                    <td className="py-2 pr-3 font-mono font-semibold">{order.code}</td>
                    <td className="py-2 pr-3">{order.store}</td>
                    <td className="py-2 pr-3">
                      {order.area || (
                        // This one is fixable today: somebody types an area name and it
                        // starts matching a patch.
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                          no area on the address
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 tabular-nums">{order.waitingMinutes} min</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
        <h2 className="mb-3 font-bold">Riders</h2>
        {riders.length === 0 ? (
          <p className="text-sm text-ink-muted">No riders yet.</p>
        ) : (
          <ul className="space-y-2">
            {riders.map((rider) => (
              <li key={rider.id} className="rounded-xl border border-surface-line px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">
                      {rider.name}
                      {rider.onDuty && (
                        <span className="ml-2 text-xs font-bold text-emerald-700">on duty</span>
                      )}
                      {rider.openAlerts > 0 && (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                          {rider.openAlerts} alert{rider.openAlerts > 1 ? 's' : ''}
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-ink-faint">
                      {rider.phone} · {rider.vehicle.toLowerCase()} · {rider.capacityKg} kg
                      {rider.areas.length > 0 && ` · ${rider.areas.join(', ')}`}
                    </p>
                    <p className="truncate text-xs text-ink-faint">
                      {rider.shops.length > 0 ? rider.shops.join(' · ') : 'no shops yet'}
                    </p>
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

                  {rider.lat != null && rider.lng != null ? (
                    <a
                      href={`https://maps.google.com/?q=${rider.lat},${rider.lng}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-ghost px-3 text-xs"
                    >
                      Last seen {fixAge(rider.locationAt)}
                    </a>
                  ) : (
                    <span className="text-xs text-ink-faint">no position shared</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PlatformShell>
  );
}

function Stat({ label, value, tone = 'plain' }: { label: string; value: string; tone?: 'plain' | 'warn' }) {
  return (
    <div className={`rounded-2xl p-4 ${tone === 'warn' ? 'bg-amber-50' : 'bg-surface-sunk'}`}>
      <p className="text-[13px] text-ink-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-extrabold tabular-nums">{value}</p>
    </div>
  );
}
