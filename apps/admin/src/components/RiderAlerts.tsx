'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../lib/auth';

interface Alert {
  id: string;
  kind: 'ACCIDENT' | 'BREAKDOWN' | 'UNSAFE' | 'OTHER';
  note: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: string;
  rider: { name: string; phone: string; emergencyPhone: string | null };
}

const LABEL: Record<Alert['kind'], string> = {
  ACCIDENT: 'Accident',
  BREAKDOWN: 'Bike trouble',
  UNSAFE: 'Does not feel safe',
  OTHER: 'Something wrong',
};

/**
 * A rider has said something is wrong.
 *
 * Rendered above everything else on the orders page and nowhere else, because an alert
 * that has to be navigated to is an alert nobody sees. It carries both numbers — the
 * rider's own and whoever they said to ring — and a map link, since the first useful thing
 * anyone at a counter can do is find out where they are.
 *
 * Polled on a short interval on purpose. This is the one screen where being a minute
 * behind is different in kind from being a minute behind on an order list.
 */
export function RiderAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlerts(await adminApi<Alert[]>('/vendor/ops/rider-alerts'));
    } catch {
      /* a failed poll must not clear a live alert off the screen */
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 20_000);
    return () => clearInterval(timer);
  }, [load]);

  const resolve = async (id: string) => {
    setBusy(id);
    try {
      await adminApi(`/vendor/ops/rider-alerts/${id}/resolve`, { method: 'POST' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (alerts.length === 0) return null;

  return (
    <section className="mb-6 space-y-2">
      {alerts.map((alert) => (
        <article key={alert.id} className="rounded-2xl border-2 border-red-300 bg-red-50 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-bold text-red-900">
                {LABEL[alert.kind]} — {alert.rider.name}
              </p>
              {alert.note && <p className="mt-0.5 text-sm text-red-800">“{alert.note}”</p>}
              <p className="mt-0.5 text-xs text-red-700">
                {new Date(alert.createdAt).toLocaleString()}
              </p>
            </div>

            <a href={`tel:${alert.rider.phone}`} className="btn-ghost gap-1.5 px-3">
              Call {alert.rider.name.split(' ')[0]}
            </a>
            {alert.rider.emergencyPhone && (
              <a href={`tel:${alert.rider.emergencyPhone}`} className="btn-ghost gap-1.5 px-3">
                Emergency contact
              </a>
            )}
            {alert.lat != null && alert.lng != null && (
              <a
                href={`https://maps.google.com/?q=${alert.lat},${alert.lng}`}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost gap-1.5 px-3"
              >
                Where they are
              </a>
            )}

            <button
              type="button"
              disabled={busy === alert.id}
              onClick={() => resolve(alert.id)}
              className="rounded-full bg-red-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-60"
            >
              Dealt with
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
