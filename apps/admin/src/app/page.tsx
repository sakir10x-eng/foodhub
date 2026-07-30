'use client';

import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  ACTIVE_STATUSES,
  formatBDT,
  ORDER_STATUS_LABEL,
  type OrderDto,
  type OrderStatus,
  type VendorSummary,
} from '@foodhub/shared';
import { adminApi, API_BASE, useAuth } from '../lib/auth';
import { Banner, PageHeader, Shell } from '../components/Shell';
import { KitchenTicket } from '../components/KitchenTicket';
import { Icon } from '../components/Icon';

/** What the vendor should do next, per status. One tap, no menus. */
const NEXT_ACTION: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  PENDING: { to: 'CONFIRMED', label: 'Accept' },
  CONFIRMED: { to: 'PREPARING', label: 'Start cooking' },
  PREPARING: { to: 'READY', label: 'Mark ready' },
  READY: { to: 'ON_THE_WAY', label: 'Out for delivery' },
  ON_THE_WAY: { to: 'DELIVERED', label: 'Delivered' },
};

export default function DashboardPage() {
  return (
    <Shell>
      <Dashboard />
    </Shell>
  );
}

function Dashboard() {
  const [summary, setSummary] = useState<VendorSummary | null>(null);
  const [queue, setQueue] = useState<OrderDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ticket, setTicket] = useState<OrderDto | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, q] = await Promise.all([
        adminApi<VendorSummary>('/vendor/summary'),
        adminApi<OrderDto[]>('/vendor/orders/queue'),
      ]);
      setSummary(s);
      setQueue(q);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Live queue. A new order has to appear without anyone refreshing anything.
  useEffect(() => {
    const token = useAuth.getState().accessToken;
    if (!token) return;
    const socket: Socket = io(API_BASE || undefined, { path: '/realtime', transports: ['websocket', 'polling'] });
    socket.on('connect', () => socket.emit('vendor:subscribe', { token }));
    socket.on('order:new', (order: OrderDto) => {
      setQueue((prev) => (prev.some((o) => o.id === order.id) ? prev : [...prev, order]));
      if (typeof Audio !== 'undefined') {
        // A kitchen is loud and nobody is watching the screen.
        try { new Audio('data:audio/wav;base64,UklGRl9vAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play(); } catch {}
      }
    });
    socket.on('order:updated', (order: OrderDto) => {
      setQueue((prev) => {
        const active = ACTIVE_STATUSES.includes(order.status);
        const without = prev.filter((o) => o.id !== order.id);
        return active ? [...without, order].sort((a, b) => a.placedAt.localeCompare(b.placedAt)) : without;
      });
    });
    return () => { socket.close(); };
  }, []);

  const advance = async (order: OrderDto, to: OrderStatus) => {
    setBusyId(order.id);
    // Optimistic: the card moves now, and the socket echo confirms it.
    setQueue((prev) => prev.map((o) => (o.id === order.id ? { ...o, status: to } : o)));
    try {
      await adminApi(`/vendor/orders/${order.id}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: to }),
      });
      await load();
    } catch (err) {
      setError((err as Error).message);
      await load(); // roll back to the truth
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <PageHeader title="Today" action={summary ? <OpenToggle summary={summary} onChange={load} /> : null} />

      <div className="space-y-5 p-4">
        {error && <Banner tone="error">{error}</Banner>}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Orders today" value={summary ? String(summary.today.orders) : null} />
          <Stat label="Revenue today" value={summary ? formatBDT(summary.today.revenue) : null} />
          <Stat label="In progress" value={summary ? String(summary.today.activeOrders) : null} />
          <Stat
            label="Marketplace payout due"
            value={summary ? formatBDT(summary.pendingPayout) : null}
            hint={summary?.tenant.listedOnMarketplace ? undefined : 'not listed'}
          />
          {/* The vendor sees the same score their customers do — including the honest
              "New" when nobody has rated them yet. */}
          <Stat
            label="Customer rating"
            value={
              summary
                ? summary.tenant.rating != null
                  ? `★ ${summary.tenant.rating.toFixed(1)}`
                  : 'New'
                : null
            }
            hint={
              summary?.tenant.ratingCount
                ? `${summary.tenant.ratingCount} rating${summary.tenant.ratingCount === 1 ? '' : 's'}`
                : 'no ratings yet'
            }
          />
        </div>

        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-faint">Live queue</h2>
          {queue.length === 0 ? (
            <Banner>No orders in progress. New ones appear here the moment they land.</Banner>
          ) : (
            <ul className="space-y-3">
              {queue.map((order) => {
                const next = NEXT_ACTION[order.status];
                return (
                  <li key={order.id} className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="flex items-center gap-2 font-bold">
                          {order.code}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              order.channel === 'MARKETPLACE'
                                ? 'bg-violet-100 text-violet-700'
                                : 'bg-emerald-100 text-emerald-700'
                            }`}
                          >
                            {order.channel === 'MARKETPLACE' ? 'Marketplace' : 'Own store'}
                          </span>
                        </p>
                        <p className="mt-0.5 text-sm text-ink-muted">
                          {order.deliveryAddress.name} · {order.deliveryAddress.phone}
                        </p>
                        <p className="text-sm text-ink-muted">
                          {order.deliveryAddress.addressLine}, {order.deliveryAddress.area}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold tabular-nums">{formatBDT(order.total)}</p>
                        <p className="text-xs text-ink-muted">
                          {order.paymentMethod === 'COD' ? 'Cash on delivery' : order.paymentStatus}
                        </p>
                        {order.commissionAmount > 0 && (
                          <p className="text-xs text-ink-faint">
                            commission {formatBDT(order.commissionAmount)}
                          </p>
                        )}
                      </div>
                    </div>

                    <ul className="mt-3 space-y-0.5 text-sm">
                      {order.items.map((item) => (
                        <li key={item.id}>
                          <span className="tabular-nums text-ink-muted">{item.qty}×</span> {item.nameSnapshot}
                        </li>
                      ))}
                    </ul>

                    <div className="mt-4 flex flex-wrap gap-2">
                      {/* Paper first: a cook with wet hands is not reading a tablet. */}
                      <button
                        onClick={() => setTicket(order)}
                        className="btn-ghost gap-1.5 px-3"
                        aria-label={`Print ticket for ${order.code}`}
                      >
                        <Icon name="orders" size={15} /> Ticket
                      </button>
                      {next && (
                        <button
                          onClick={() => advance(order, next.to)}
                          disabled={busyId === order.id}
                          className="btn-brand flex-1"
                        >
                          {next.label}
                        </button>
                      )}
                      <button
                        onClick={() => advance(order, 'CANCELLED')}
                        disabled={busyId === order.id}
                        className="btn-ghost"
                      >
                        Cancel
                      </button>
                    </div>
                    <p className="mt-2 text-xs text-ink-faint">
                      Currently {ORDER_STATUS_LABEL[order.status]}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      {ticket && <KitchenTicket order={ticket} onClose={() => setTicket(null)} />}
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      {value === null ? (
        <div className="skeleton mt-2 h-6 w-20" />
      ) : (
        <p className="mt-1 text-xl font-extrabold tabular-nums">{value}</p>
      )}
      {hint && <p className="mt-0.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

/** The most-used control in the whole panel: are we taking orders right now? */
function OpenToggle({ summary, onChange }: { summary: VendorSummary; onChange: () => void }) {
  const [open, setOpen] = useState(summary.tenant.isOpen);
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    setBusy(true);
    try {
      await adminApi('/vendor/open', { method: 'POST', body: JSON.stringify({ value: next }) });
      onChange();
    } catch {
      setOpen(!next);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={toggle}
      disabled={busy}
      aria-pressed={open}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
        open ? 'bg-emerald-100 text-emerald-800' : 'bg-surface-sunk text-ink-muted'
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${open ? 'bg-emerald-500' : 'bg-ink-faint'}`} />
      {open ? 'Open' : 'Closed'}
    </button>
  );
}
