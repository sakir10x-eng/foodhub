'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatBDT, ORDER_STATUS_LABEL, type OrderDto, type Paginated } from '@foodhub/shared';
import { adminApi } from '../../lib/auth';
import { Banner, PageHeader, Shell } from '../../components/Shell';
import { Riders } from '../../components/Riders';

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'OWN_STORE', label: 'Own store' },
  { key: 'MARKETPLACE', label: 'Marketplace' },
] as const;

/**
 * Where a customer-facing page lives, seen from the admin panel.
 *
 * The panel is always `admin.<platform domain>`, so dropping that one label lands on the
 * marketplace host — which is where the rider run sheet is served from. Derived from the
 * live origin rather than an env var so a vendor on a custom domain still gets a link
 * that works from the browser they are actually using.
 */
function storefrontUrl(): string {
  if (typeof window === 'undefined') return '';
  const { protocol, host } = window.location;
  return `${protocol}//${host.replace(/^admin\./, '')}`;
}

export default function OrdersPage() {
  return (
    <Shell>
      <OrderHistory />
    </Shell>
  );
}

function OrderHistory() {
  const [channel, setChannel] = useState<string>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<OrderDto> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    try {
      const query = new URLSearchParams({ page: String(page), pageSize: '25' });
      if (channel) query.set('channel', channel);
      setData(await adminApi<Paginated<OrderDto>>(`/vendor/orders?${query}`));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [channel, page]);

  useEffect(() => { void load(); }, [load]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="Orders" />

      <div className="p-4">
        {error && <Banner tone="error">{error}</Banner>}

        <Riders storefrontUrl={storefrontUrl()} />

        <div className="mb-4 flex gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setChannel(f.key); setPage(1); }}
              className={`rounded-full px-4 py-2 text-sm font-medium transition ${
                channel === f.key ? 'bg-brand text-white' : 'bg-surface-sunk text-ink-muted'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {!data && <div className="space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}</div>}

        {data && data.data.length === 0 && <Banner>No orders yet on this channel.</Banner>}

        {data && data.data.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-surface-line text-left text-xs uppercase tracking-wide text-ink-faint">
                  <th className="py-2 pr-3 font-semibold">Order</th>
                  <th className="py-2 pr-3 font-semibold">Channel</th>
                  <th className="py-2 pr-3 font-semibold">Customer</th>
                  <th className="py-2 pr-3 font-semibold">Status</th>
                  <th className="py-2 pr-3 text-right font-semibold">Total</th>
                  <th className="py-2 text-right font-semibold">Commission</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-line">
                {data.data.map((order) => (
                  <tr key={order.id}>
                    <td className="py-2.5 pr-3">
                      <span className="font-semibold">{order.code}</span>
                      <span className="block text-xs text-ink-faint">
                        {new Date(order.placedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                        order.channel === 'MARKETPLACE' ? 'bg-violet-100 text-violet-700' : 'bg-emerald-100 text-emerald-700'
                      }`}>
                        {order.channel === 'MARKETPLACE' ? 'Marketplace' : 'Own store'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      {order.deliveryAddress.name}
                      <span className="block text-xs text-ink-faint">{order.deliveryAddress.phone}</span>
                    </td>
                    <td className="py-2.5 pr-3">{ORDER_STATUS_LABEL[order.status]}</td>
                    <td className="py-2.5 pr-3 text-right tabular-nums">
                      {formatBDT(order.total)}
                      {/* What the rider actually has to collect — the number the kitchen
                          reads out when handing over the bag. */}
                      {order.advanceAmount > 0 && order.dueOnDelivery > 0 && (
                        <span className="block text-[11px] font-semibold text-amber-700">
                          collect {formatBDT(order.dueOnDelivery)}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right tabular-nums text-ink-muted">
                      {order.commissionAmount > 0 ? `−${formatBDT(order.commissionAmount)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && pages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn-ghost h-10 min-h-0 px-3 text-sm">
              Previous
            </button>
            <span className="text-ink-muted">Page {page} of {pages}</span>
            <button disabled={page >= pages} onClick={() => setPage((p) => p + 1)} className="btn-ghost h-10 min-h-0 px-3 text-sm">
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
