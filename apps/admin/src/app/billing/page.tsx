'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  formatBDT, PLAN_PRICING, type InvoiceDto, type Plan, type SettlementDto,
} from '@foodhub/shared';
import { adminApi } from '../../lib/auth';
import { Banner, PageHeader, Shell } from '../../components/Shell';

interface Subscription { plan: Plan; amount: number; nextBillingAt: string; planStatus: string }

export default function BillingPage() {
  return (
    <Shell>
      <Billing />
    </Shell>
  );
}

/**
 * Both revenue models in one place, deliberately: the vendor sees what they pay us for
 * the software (a fixed monthly fee) separately from what we owe them for marketplace
 * orders (payouts minus commission).
 */
function Billing() {
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDto[]>([]);
  const [settlements, setSettlements] = useState<SettlementDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [sub, inv, set] = await Promise.all([
        adminApi<Subscription>('/vendor/billing/subscription'),
        adminApi<InvoiceDto[]>('/vendor/billing/invoices'),
        adminApi<SettlementDto[]>('/vendor/billing/settlements'),
      ]);
      setSubscription(sub);
      setInvoices(inv);
      setSettlements(set);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const changePlan = async (plan: Plan) => {
    setBusy(true);
    setError(null);
    try {
      await adminApi('/vendor/billing/plan', { method: 'POST', body: JSON.stringify({ plan }) });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pay = async (invoice: InvoiceDto) => {
    setBusy(true);
    try {
      await adminApi(`/vendor/billing/invoices/${invoice.id}/pay`, {
        method: 'POST',
        body: JSON.stringify({ paymentRef: `MANUAL-${Date.now()}` }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Money" />

      <div className="max-w-2xl space-y-6 p-4">
        {error && <Banner tone="error">{error}</Banner>}

        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-faint">Your plan</h2>
          <p className="mb-3 text-sm text-ink-muted">
            A flat monthly fee for your own storefront. Orders on your own site never carry a commission.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {(Object.keys(PLAN_PRICING) as Plan[]).map((plan) => {
              const info = PLAN_PRICING[plan];
              const current = subscription?.plan === plan;
              return (
                <div key={plan}
                     className={`rounded-2xl border p-4 shadow-card ${current ? 'border-brand bg-brand/5' : 'border-surface-line bg-white'}`}>
                  <p className="font-bold">{info.label}</p>
                  <p className="mt-1 text-lg font-extrabold tabular-nums">
                    {info.monthly === 0 ? 'Free' : `${formatBDT(info.monthly)}/mo`}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs text-ink-muted">
                    {info.features.map((f) => <li key={f}>· {f}</li>)}
                  </ul>
                  {current ? (
                    <p className="mt-3 text-xs font-semibold text-brand">Current plan</p>
                  ) : (
                    <button onClick={() => changePlan(plan)} disabled={busy}
                            className="btn-ghost mt-3 h-9 min-h-0 w-full px-3 text-sm">
                      Switch
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-faint">Invoices from FoodHub</h2>
          {invoices.length === 0 ? (
            <Banner>No invoices yet — you are on a free plan or your first cycle has not closed.</Banner>
          ) : (
            <ul className="divide-y divide-surface-line rounded-2xl border border-surface-line bg-white px-4 shadow-card">
              {invoices.map((invoice) => (
                <li key={invoice.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <span>
                    <span className="font-semibold">{invoice.number}</span>
                    <span className="block text-xs text-ink-faint">
                      {invoice.periodLabel} · due {new Date(invoice.dueAt).toLocaleDateString('en-GB')}
                    </span>
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums">{formatBDT(invoice.amount)}</span>
                    {invoice.status === 'PAID' ? (
                      <span className="text-xs font-semibold text-emerald-700">Paid</span>
                    ) : (
                      <button onClick={() => pay(invoice)} disabled={busy}
                              className="btn-brand h-9 min-h-0 px-3 text-sm">Pay</button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-faint">
            Marketplace payouts to you
          </h2>
          {settlements.length === 0 ? (
            <Banner>
              No payouts yet. These appear once marketplace orders are delivered and the weekly
              settlement run closes.
            </Banner>
          ) : (
            <ul className="divide-y divide-surface-line rounded-2xl border border-surface-line bg-white px-4 shadow-card">
              {settlements.map((s) => (
                <li key={s.id} className="py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-semibold">
                      {new Date(s.periodStart).toLocaleDateString('en-GB')} –{' '}
                      {new Date(s.periodEnd).toLocaleDateString('en-GB')}
                    </span>
                    <span className="tabular-nums font-bold">{formatBDT(s.netPayable)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-faint">
                    Gross {formatBDT(s.gross)} · commission −{formatBDT(s.commission)} ·{' '}
                    {s.status === 'PAID' ? `paid ${new Date(s.paidAt!).toLocaleDateString('en-GB')}` : 'pending'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
