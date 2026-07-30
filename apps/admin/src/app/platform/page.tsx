'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBDT } from '@foodhub/shared';
import { adminApi, useAuth } from '../../lib/auth';
import { Banner, PageHeader, PlatformShell } from '../../components/Shell';
import { Icon } from '../../components/Icon';

interface Overview {
  days: number;
  vendors: { total: number; byStatus: Record<string, number>; onMarketplace: number };
  gmv: number;
  orders: number;
  byChannel: { channel: string; orders: number; gmv: number }[];
  commissionEarned: number;
  subscriptionMrr: number;
  activeSubscriptions: number;
  outstandingInvoices: { count: number; amount: number };
  pendingPayouts: { count: number; amount: number };
}

interface Tenant {
  id: string; slug: string; name: string; plan: string; planStatus: string;
  listedOnMarketplace: boolean; isOpen: boolean; commissionRateBps: number; createdAt: string;
  /** Paid placement is live right now. */
  promoted?: boolean;
  _count: { orders: number; products: number };
}

interface Settlement {
  id: string; tenantSlug: string; tenantName: string;
  periodStart: string; periodEnd: string;
  gross: number; commission: number; netPayable: number; status: string; paidAt: string | null;
}

export default function PlatformPage() {
  return (
    <PlatformShell>
      <Platform />
    </PlatformShell>
  );
}

/**
 * The superadmin console.
 *
 * Deliberately the only screen in the product that reads across every tenant — it runs
 * behind `@Roles('PLATFORM_ADMIN')` and an audited `@PlatformScope`. The two revenue
 * lines are kept apart on purpose: commission is Mode B, subscriptions are Mode A, and
 * summing them into one "revenue" number would hide which business model is working.
 */
function Platform() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [o, t, s] = await Promise.all([
        adminApi<Overview>('/platform/overview?days=30'),
        adminApi<Tenant[]>(`/platform/tenants${query ? `?q=${encodeURIComponent(query)}` : ''}`),
        adminApi<Settlement[]>('/platform/settlements?status=PENDING'),
      ]);
      setOverview(o); setTenants(t); setSettlements(s);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, label: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      setNotice(label);
      setTimeout(() => setNotice(null), 2500);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const setStatus = (t: Tenant, status: 'ACTIVE' | 'SUSPENDED') =>
    act(t.id, `${t.name} ${status === 'SUSPENDED' ? 'suspended' : 'reactivated'}`, () =>
      adminApi(`/platform/tenants/${t.id}/plan-status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    );

  const promote = (t: Tenant) => {
    const days = window.prompt(`Promote ${t.name} at the top of the feed for how many days?`, '7');
    if (!days) return;
    const n = Number(days);
    if (!Number.isFinite(n) || n < 1 || n > 365) return;
    return act(t.id, `${t.name} promoted for ${n} days`, () =>
      adminApi(`/platform/tenants/${t.id}/promote`, { method: 'POST', body: JSON.stringify({ days: n, rank: 10 }) }),
    );
  };

  const endPromotion = (t: Tenant) =>
    act(t.id, `${t.name} is no longer promoted`, () =>
      adminApi(`/platform/tenants/${t.id}/promote`, { method: 'DELETE' }),
    );

  const setCommission = (t: Tenant) => {
    const input = window.prompt(`Commission for ${t.name} (%)`, (t.commissionRateBps / 100).toFixed(1));
    if (input === null) return;
    const pct = Number(input);
    if (!Number.isFinite(pct) || pct < 0 || pct > 50) {
      setError('Commission must be between 0 and 50%');
      return;
    }
    return act(t.id, `${t.name} commission set to ${pct}%`, () =>
      adminApi(`/platform/tenants/${t.id}/commission`, {
        method: 'PATCH',
        body: JSON.stringify({ bps: Math.round(pct * 100) }),
      }),
    );
  };

  const runPayout = (t: Tenant) =>
    act(t.id, `Settlement run for ${t.name}`, () =>
      adminApi('/platform/settlements/run', { method: 'POST', body: JSON.stringify({ tenantId: t.id }) }),
    );

  const markPaid = (s: Settlement) =>
    act(s.id, `Payout to ${s.tenantName} marked paid`, () =>
      adminApi(`/platform/settlements/${s.id}/paid`, {
        method: 'POST',
        body: JSON.stringify({ paymentRef: `MANUAL-${Date.now()}` }),
      }),
    );

  const marketplaceGmv = overview?.byChannel.find((c) => c.channel === 'MARKETPLACE')?.gmv ?? 0;
  const ownStoreGmv = overview?.byChannel.find((c) => c.channel === 'OWN_STORE')?.gmv ?? 0;
  const totalGmv = Math.max(1, marketplaceGmv + ownStoreGmv);

  return (
    <>
      <PageHeader
        title="Platform"
        action={
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1.5 text-xs font-bold text-brand">
            <Icon name="shield" size={14} /> Superadmin
          </span>
        }
      />

      <div className="space-y-6 p-4">
        {error && <Banner tone="error">{error}</Banner>}
        {notice && <Banner tone="info">{notice}</Banner>}

        {/* ── the two revenue models, side by side and never conflated */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi
            icon="wallet" label="Commission earned" sub="Mode B · marketplace, last 30d"
            value={overview && formatBDT(overview.commissionEarned)}
          />
          <Kpi
            icon="sparkles" label="Subscription MRR" sub={`Mode A · ${overview?.activeSubscriptions ?? 0} active plans`}
            value={overview && formatBDT(overview.subscriptionMrr)}
          />
          <Kpi
            icon="bag" label="GMV (30d)" sub={`${overview?.orders ?? 0} orders`}
            value={overview && formatBDT(overview.gmv)}
          />
          <Kpi
            icon="store" label="Vendors" sub={`${overview?.vendors.onMarketplace ?? 0} on the marketplace`}
            value={overview && String(overview.vendors.total)}
          />
        </div>

        {/* ── things that need a human */}
        <div className="grid gap-3 sm:grid-cols-2">
          <ActionCard
            icon="money" tone={overview?.pendingPayouts.count ? 'warn' : 'calm'}
            title={`${overview?.pendingPayouts.count ?? 0} payout${overview?.pendingPayouts.count === 1 ? '' : 's'} pending`}
            detail={`${formatBDT(overview?.pendingPayouts.amount ?? 0)} owed to vendors`}
          />
          <ActionCard
            icon="alert" tone={overview?.outstandingInvoices.count ? 'warn' : 'calm'}
            title={`${overview?.outstandingInvoices.count ?? 0} invoice${overview?.outstandingInvoices.count === 1 ? '' : 's'} unpaid`}
            detail={`${formatBDT(overview?.outstandingInvoices.amount ?? 0)} owed to us`}
          />
        </div>

        {overview && (
          <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
            <h2 className="flex items-center gap-2 font-bold">
              <Icon name="chart" size={16} /> Where the volume comes from
            </h2>
            <div className="mt-3 flex h-3 overflow-hidden rounded-full bg-surface-sunk">
              <div className="bg-emerald-500" style={{ width: `${(ownStoreGmv / totalGmv) * 100}%` }} />
              <div className="bg-violet-400" style={{ width: `${(marketplaceGmv / totalGmv) * 100}%` }} />
            </div>
            <div className="mt-3 flex flex-wrap gap-5 text-sm">
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500" />
                Own store <strong className="tabular-nums">{formatBDT(ownStoreGmv)}</strong>
                <span className="text-ink-faint">(no commission)</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-sm bg-violet-400" />
                Marketplace <strong className="tabular-nums">{formatBDT(marketplaceGmv)}</strong>
              </span>
            </div>
          </section>
        )}

        {/* ── vendors */}
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-ink-faint">
              <Icon name="users" size={15} /> Vendors
            </h2>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
                <Icon name="search" size={15} />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search vendors"
                aria-label="Search vendors"
                className="field h-10 min-h-0 w-48 py-0 pl-9 text-sm"
              />
            </div>
          </div>

          {tenants.length === 0 ? (
            <Banner>No vendors match.</Banner>
          ) : (
            <ul className="space-y-2">
              {tenants.map((t) => (
                <li key={t.id} className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-bold">
                        {t.name}
                        <StatusChip status={t.planStatus} />
                        <span className="rounded-full bg-surface-sunk px-2 py-0.5 text-[11px] font-semibold text-ink-muted">
                          {t.plan}
                        </span>
                        {t.listedOnMarketplace && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-semibold text-violet-700">
                            <Icon name="globe" size={11} /> Marketplace
                          </span>
                        )}
                      </p>
                      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
                        <span>/{t.slug}</span>
                        <span className="inline-flex items-center gap-1">
                          <Icon name="bag" size={12} /> {t._count.orders} orders
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Icon name="menu" size={12} /> {t._count.products} items
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Icon name="tag" size={12} /> {(t.commissionRateBps / 100).toFixed(1)}% commission
                        </span>
                        <span className={t.isOpen ? 'text-emerald-700' : ''}>
                          {t.isOpen ? 'Open' : 'Closed'}
                        </span>
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setCommission(t)} disabled={busy === t.id}
                              className="btn-ghost h-9 min-h-0 gap-1.5 px-3 text-xs">
                        <Icon name="tag" size={14} /> Commission
                      </button>
                      <button onClick={() => runPayout(t)} disabled={busy === t.id}
                              className="btn-ghost h-9 min-h-0 gap-1.5 px-3 text-xs">
                        <Icon name="money" size={14} /> Run payout
                      </button>
                      {/* Paid placement: the highest-margin line in the business, since
                          no food is cooked for it. */}
                      {t.promoted ? (
                        <button onClick={() => endPromotion(t)} disabled={busy === t.id}
                                className="btn-ghost h-9 min-h-0 gap-1.5 px-3 text-xs text-violet-700">
                          <Icon name="star" size={14} /> Promoted · end
                        </button>
                      ) : (
                        <button onClick={() => promote(t)} disabled={busy === t.id}
                                className="btn-ghost h-9 min-h-0 gap-1.5 px-3 text-xs">
                          <Icon name="star" size={14} /> Promote
                        </button>
                      )}
                      {t.planStatus === 'SUSPENDED' ? (
                        <button onClick={() => setStatus(t, 'ACTIVE')} disabled={busy === t.id}
                                className="btn-brand h-9 min-h-0 gap-1.5 px-3 text-xs">
                          <Icon name="play" size={14} /> Reactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            // Suspending takes a live storefront offline — confirm it.
                            if (window.confirm(`Suspend ${t.name}? Their storefront goes dark immediately.`)) {
                              void setStatus(t, 'SUSPENDED');
                            }
                          }}
                          disabled={busy === t.id}
                          className="btn-ghost h-9 min-h-0 gap-1.5 px-3 text-xs text-red-700"
                        >
                          <Icon name="pause" size={14} /> Suspend
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── payouts awaiting money movement */}
        <section>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-ink-faint">
            <Icon name="wallet" size={15} /> Pending payouts
          </h2>
          {settlements.length === 0 ? (
            <Banner>Nothing owed right now. Settlement runs weekly, or on demand above.</Banner>
          ) : (
            <ul className="divide-y divide-surface-line rounded-2xl border border-surface-line bg-white px-4 shadow-card">
              {settlements.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <span>
                    <span className="font-semibold">{s.tenantName}</span>
                    <span className="block text-xs text-ink-faint">
                      {new Date(s.periodStart).toLocaleDateString('en-GB')} –{' '}
                      {new Date(s.periodEnd).toLocaleDateString('en-GB')} · gross {formatBDT(s.gross)} ·
                      commission −{formatBDT(s.commission)}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <strong className="tabular-nums">{formatBDT(s.netPayable)}</strong>
                    <button onClick={() => markPaid(s)} disabled={busy === s.id}
                            className="btn-brand h-9 min-h-0 gap-1.5 px-3 text-xs">
                      <Icon name="check" size={14} /> Mark paid
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function Kpi({
  icon, label, value, sub,
}: {
  icon: Parameters<typeof Icon>[0]['name']; label: string; value: string | null | undefined; sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <p className="flex items-center gap-1.5 text-xs font-medium text-ink-muted">
        <Icon name={icon} size={14} /> {label}
      </p>
      {!value ? <div className="skeleton mt-2 h-6 w-24" /> : <p className="mt-1 text-xl font-extrabold tabular-nums">{value}</p>}
      {sub && <p className="mt-0.5 text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}

function ActionCard({
  icon, title, detail, tone,
}: {
  icon: Parameters<typeof Icon>[0]['name']; title: string; detail: string; tone: 'warn' | 'calm';
}) {
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl border p-4 ${
        tone === 'warn' ? 'border-amber-200 bg-amber-50' : 'border-surface-line bg-white'
      }`}
    >
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${
        tone === 'warn' ? 'bg-amber-100 text-amber-800' : 'bg-surface-sunk text-ink-muted'}`}>
        <Icon name={icon} size={18} />
      </span>
      <span>
        <span className="block text-sm font-bold">{title}</span>
        <span className="block text-xs text-ink-muted">{detail}</span>
      </span>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, string> = {
    ACTIVE: 'bg-emerald-100 text-emerald-800',
    PAST_DUE: 'bg-amber-100 text-amber-800',
    SUSPENDED: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${map[status] ?? 'bg-surface-sunk'}`}>
      {status.replace('_', ' ').toLowerCase()}
    </span>
  );
}
