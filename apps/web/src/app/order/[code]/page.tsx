'use client';

import { use, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { io, type Socket } from 'socket.io-client';
import {
  formatBDT,
  HAPPY_PATH,
  ORDER_STATUS_LABEL,
  progressIndex,
  type OrderDto,
  type OrderStatus,
} from '@foodhub/shared';
import { API_BASE, clientApi } from '../../../lib/client';
import { RatePrompt } from '../../../components/RatePrompt';
import { PushOptIn } from '../../../components/PushOptIn';
import { PurchaseEvent } from '../../../components/Pixels';
import { AppShell } from '../../../components/AppShell';

/**
 * Live order tracking for customers and guests alike.
 *
 * The room key is the order code plus the phone it was placed with, so a guest with no
 * account still gets realtime updates while an order code on its own reveals nothing.
 */
export default function OrderPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = use(params);
  const search = useSearchParams();
  const [phone, setPhone] = useState(search.get('phone') ?? '');
  const [order, setOrder] = useState<OrderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(search.get('phone')));

  const load = async (p: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await clientApi<OrderDto>(
        `/orders/track?code=${encodeURIComponent(code)}&phone=${encodeURIComponent(p)}`,
      );
      setOrder(data);
    } catch {
      setError('We couldn’t find that order. Check the number and phone.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (search.get('phone')) void load(search.get('phone') as string);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // Subscribe once we know who is asking; every status change arrives without polling.
  useEffect(() => {
    if (!order) return;
    const socket: Socket = io(API_BASE || undefined, { path: '/realtime', transports: ['websocket', 'polling'] });
    socket.on('connect', () => socket.emit('order:subscribe', { code: order.code, phone }));
    socket.on('order:status', (update: { status: OrderStatus; events: OrderDto['events'] }) => {
      setOrder((prev) => (prev ? { ...prev, status: update.status, events: update.events } : prev));
    });
    return () => {
      socket.close();
    };
  }, [order?.code, phone]);

  if (!order) {
    return (
      <AppShell className="px-4 py-10">
        <h1 className="text-xl font-bold">Track order {code}</h1>
        <p className="mt-1 text-sm text-ink-muted">Enter the phone number you ordered with.</p>
        <form
          onSubmit={(e) => { e.preventDefault(); void load(phone); }}
          className="mt-5 space-y-3"
        >
          <input className="field" type="tel" inputMode="numeric" placeholder="01XXXXXXXXX"
                 value={phone} onChange={(e) => setPhone(e.target.value)} required />
          <button className="btn-brand w-full" disabled={loading}>
            {loading ? 'Checking…' : 'Track order'}
          </button>
        </form>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      </AppShell>
    );
  }

  const current = progressIndex(order.status);
  const cancelled = order.status === 'CANCELLED' || order.status === 'REFUNDED';

  return (
    <AppShell className="px-4 pb-16 pt-8">
      <p className="text-sm text-ink-muted">Order</p>
      <h1 className="text-2xl font-extrabold tracking-tight">{order.code}</h1>

      <div className="card mt-5 p-4">
        {cancelled ? (
          <p className="text-sm font-semibold text-red-700">{ORDER_STATUS_LABEL[order.status]}</p>
        ) : (
          <ol className="space-y-0">
            {HAPPY_PATH.map((status, i) => {
              const done = i <= current;
              const active = i === current;
              return (
                <li key={status} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <span
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold transition ${
                        done ? 'bg-brand text-white' : 'bg-surface-sunk text-ink-faint'
                      }`}
                    >
                      {done ? '✓' : i + 1}
                    </span>
                    {i < HAPPY_PATH.length - 1 && (
                      <span className={`h-7 w-px ${i < current ? 'bg-brand' : 'bg-surface-line'}`} />
                    )}
                  </div>
                  <span className={`pb-3 text-sm ${active ? 'font-bold' : done ? 'text-ink-muted' : 'text-ink-faint'}`}>
                    {ORDER_STATUS_LABEL[status]}
                    {active && <span className="ml-2 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand align-middle" />}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-ink-faint">Items</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="tabular-nums text-ink-muted">{item.qty}×</span> {item.nameSnapshot}
              </span>
              <span className="tabular-nums">{formatBDT(item.priceSnapshot * item.qty)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-surface-line pt-3 text-sm">
          <div className="flex justify-between text-ink-muted">
            <dt>Subtotal</dt><dd className="tabular-nums">{formatBDT(order.subtotal)}</dd>
          </div>
          <div className="flex justify-between text-ink-muted">
            <dt>{order.fulfillment === 'PICKUP' ? 'Pickup' : 'Delivery'}</dt>
            <dd className="tabular-nums">
              {order.fulfillment === 'PICKUP' ? 'No fee' : formatBDT(order.deliveryFee)}
            </dd>
          </div>
          {order.discount > 0 && (
            <div className="flex justify-between text-emerald-700">
              <dt>Discount</dt><dd className="tabular-nums">−{formatBDT(order.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between pt-1 text-base font-bold">
            <dt>Total</dt><dd className="tabular-nums">{formatBDT(order.total)}</dd>
          </div>
          {/*
            On a part-paid order this is the number that matters most: exactly what to
            have ready when the doorbell goes. Leaving the customer to subtract the
            advance from the total themselves is how riders end up arguing on doorsteps.
          */}
          {order.advanceAmount > 0 && order.dueOnDelivery > 0 && (
            <>
              <div className="flex justify-between text-ink-muted">
                <dt>Paid online</dt>
                <dd className="tabular-nums">−{formatBDT(order.advanceAmount)}</dd>
              </div>
              <div className="flex justify-between rounded-lg bg-amber-50 px-2 py-1.5 font-bold text-amber-900">
                <dt>Cash on delivery</dt>
                <dd className="tabular-nums">{formatBDT(order.dueOnDelivery)}</dd>
              </div>
            </>
          )}
        </dl>
        <p className="mt-3 text-xs text-ink-muted">
          {order.dueOnDelivery > 0 && order.advanceAmount > 0
            ? `Advance paid · have ${formatBDT(order.dueOnDelivery)} ready for the rider`
            : order.paymentMethod === 'COD'
              ? 'Pay the rider on delivery'
              : `Paid · ${order.paymentStatus}`}
        </p>
      </section>

      {/* Asked here, not on arrival: the customer has food in the oven and a reason
          to say yes. The browser only lets you ask once. */}
      {/* The vendor's ad platforms only learn a campaign worked if this fires. Guarded
          against a refresh reporting the same sale twice. */}
      <PurchaseEvent code={order.code} value={order.total} />

      <PushOptIn phone={phone} />

      <RatePrompt order={order} phone={phone} />

      <Link href="/" className="btn-ghost mt-5 w-full">Order something else</Link>
    </AppShell>
  );
}
