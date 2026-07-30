'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { adminApi } from '../../lib/auth';
import { Banner, PageHeader, Shell } from '../../components/Shell';

interface Overview {
  days: number;
  orders: number;
  revenue: number;
  averageOrderValue: number;
  commissionPaid: number;
  revenueChangePct: number | null;
  ordersChangePct: number | null;
  byChannel: { channel: string; orders: number; revenue: number; commission: number }[];
}
interface BestSeller { productId: string | null; name: string; qty: number; revenue: number; orders: number }
interface HourBucket { hour: number; orders: number; revenue: number }
interface DayPoint { date: string; orders: number; revenue: number; ownStore: number; marketplace: number }
interface Alert { productId: string; name: string; reason: string; detail: string }

const RANGES = [7, 30, 90] as const;

export default function AnalyticsPage() {
  return (
    <Shell>
      <Analytics />
    </Shell>
  );
}

function Analytics() {
  const [days, setDays] = useState<number>(30);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [best, setBest] = useState<BestSeller[]>([]);
  const [hours, setHours] = useState<HourBucket[]>([]);
  const [trend, setTrend] = useState<DayPoint[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setOverview(null);
    try {
      const [o, b, h, t, a] = await Promise.all([
        adminApi<Overview>(`/vendor/analytics/overview?days=${days}`),
        adminApi<BestSeller[]>(`/vendor/analytics/best-sellers?days=${days}`),
        adminApi<HourBucket[]>(`/vendor/analytics/peak-hours?days=${days}`),
        adminApi<DayPoint[]>(`/vendor/analytics/trend?days=${days}`),
        adminApi<Alert[]>('/vendor/analytics/alerts'),
      ]);
      setOverview(o); setBest(b); setHours(h); setTrend(t); setAlerts(a);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [days]);

  useEffect(() => { void load(); }, [load]);

  const peakHour = hours.reduce((best, h) => (h.orders > (best?.orders ?? -1) ? h : best), hours[0]);
  const maxHourOrders = Math.max(1, ...hours.map((h) => h.orders));
  const maxTrend = Math.max(1, ...trend.map((t) => t.revenue));

  return (
    <>
      <PageHeader
        title="Analytics"
        action={
          <div className="flex gap-1 rounded-full bg-surface-sunk p-1">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                  days === r ? 'bg-white text-ink shadow-card' : 'text-ink-muted'
                }`}
              >
                {r}d
              </button>
            ))}
          </div>
        }
      />

      <div className="space-y-6 p-4">
        {error && <Banner tone="error">{error}</Banner>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label={`Revenue (${days}d)`} value={overview && formatBDT(overview.revenue)} change={overview?.revenueChangePct} />
          <Stat label="Orders" value={overview && String(overview.orders)} change={overview?.ordersChangePct} />
          <Stat label="Average order" value={overview && formatBDT(overview.averageOrderValue)} />
          <Stat label="Commission paid" value={overview && formatBDT(overview.commissionPaid)} hint="marketplace only" />
        </div>

        {alerts.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-faint">Worth a look</h2>
            <ul className="space-y-2">
              {alerts.map((alert) => (
                <li
                  key={alert.productId}
                  className={`rounded-xl px-4 py-3 text-sm ${
                    alert.reason === 'SOLD_OUT_BUT_SELLING' ? 'bg-amber-50 text-amber-900' : 'bg-surface-sunk text-ink-muted'
                  }`}
                >
                  <span className="font-semibold">{alert.name}</span> — {alert.detail}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <h2 className="font-bold">Revenue by day</h2>
          {trend.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">No orders in this period yet.</p>
          ) : (
            <>
              {/* Stacked bars: own-store vs marketplace, so the channel mix is legible
                  at a glance rather than needing a second chart. */}
              <div className="mt-4 flex h-40 items-end gap-[3px]" role="img" aria-label="Daily revenue by channel">
                {trend.map((point) => (
                  <div key={point.date} className="group relative flex-1" title={`${point.date}: ${formatBDT(point.revenue)}`}>
                    <div className="flex flex-col justify-end" style={{ height: '160px' }}>
                      <div
                        className="w-full rounded-t-sm bg-violet-400"
                        style={{ height: `${(point.marketplace / maxTrend) * 100}%` }}
                      />
                      <div
                        className="w-full bg-emerald-500"
                        style={{ height: `${(point.ownStore / maxTrend) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex gap-4 text-xs text-ink-muted">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-emerald-500" /> Own store</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-violet-400" /> Marketplace</span>
              </div>
            </>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
            <h2 className="font-bold">Best sellers</h2>
            {best.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">Not enough orders yet.</p>
            ) : (
              <ol className="mt-3 space-y-2">
                {best.map((item, i) => (
                  <li key={`${item.productId}-${i}`} className="flex items-center gap-3 text-sm">
                    <span className="w-5 shrink-0 text-xs font-bold text-ink-faint tabular-nums">{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.name}</span>
                      <span className="block h-1 rounded-full bg-brand/20">
                        <span
                          className="block h-1 rounded-full bg-brand"
                          style={{ width: `${(item.qty / best[0].qty) * 100}%` }}
                        />
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-xs tabular-nums text-ink-muted">
                      {item.qty} sold
                      <span className="block">{formatBDT(item.revenue)}</span>
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
            <h2 className="font-bold">When people order</h2>
            {peakHour && peakHour.orders > 0 ? (
              <p className="mt-1 text-sm text-ink-muted">
                Busiest at <span className="font-semibold text-ink">{formatHour(peakHour.hour)}</span> — staff for it.
              </p>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">Not enough orders yet.</p>
            )}
            <div className="mt-4 flex h-28 items-end gap-[2px]" role="img" aria-label="Orders by hour of day">
              {hours.map((h) => (
                <div
                  key={h.hour}
                  className={`flex-1 rounded-t-sm ${h.orders === 0 ? 'bg-surface-sunk' : 'bg-brand'}`}
                  style={{ height: `${Math.max(3, (h.orders / maxHourOrders) * 100)}%` }}
                  title={`${formatHour(h.hour)}: ${h.orders} orders`}
                />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-ink-faint">
              <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Stat({
  label, value, change, hint,
}: {
  label: string; value: string | null | undefined; change?: number | null; hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      {!value ? (
        <div className="skeleton mt-2 h-6 w-20" />
      ) : (
        <p className="mt-1 text-xl font-extrabold tabular-nums">{value}</p>
      )}
      {typeof change === 'number' && (
        <p className={`mt-0.5 text-xs font-semibold ${change >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
          {change >= 0 ? '↑' : '↓'} {Math.abs(change)}% vs previous period
        </p>
      )}
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

function formatHour(hour: number): string {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
