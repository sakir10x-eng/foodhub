'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatBDT, RIDER_REPORT_INTERVAL_MS } from '@foodhub/shared';
import { clientApi } from '../../lib/client';
import { AppShell } from '../../components/AppShell';
import { Icon } from '../../components/Icon';

/**
 * The rider's run sheet.
 *
 * Addressed by the token in the URL, with no login: riders change often, half of them
 * will not install anything, and a link they can bookmark is the difference between this
 * being used and not.
 *
 * Everything here is built for one hand, outdoors, in sunlight, on a phone that is not
 * new: big type, big tap targets, the address and the cash amount larger than anything
 * else, and one-tap call and navigate buttons so the rider never has to copy a number.
 */
export default function RiderPage() {
  return (
    <Suspense fallback={<AppShell className="px-4 py-10"><p className="text-sm text-ink-muted">Loading…</p></AppShell>}>
      <RunSheet />
    </Suspense>
  );
}

interface RiderOrder {
  id: string;
  code: string;
  status: string;
  total: number;
  dueOnDelivery: number;
  customerPhone: string;
  deliveryAddress: { name?: string; phone?: string; addressLine?: string; area?: string; note?: string; lat?: number | null; lng?: number | null };
}

interface Queue {
  rider: { name: string; store: string };
  orders: RiderOrder[];
}

function RunSheet() {
  const token = useSearchParams().get('token') ?? '';
  const [queue, setQueue] = useState<Queue | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      setQueue(await clientApi<Queue>(`/rider/queue?token=${encodeURIComponent(token)}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This delivery link is no longer valid');
    }
  }, [token]);

  useEffect(() => {
    void load();
    // The sheet is left open on a phone for hours; without this a rider stares at a
    // delivery the kitchen cancelled twenty minutes ago.
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!token) {
    return (
      <AppShell className="px-4 py-10">
        <h1 className="text-xl font-bold">Delivery link needed</h1>
        <p className="mt-2 text-sm text-ink-muted">Open the link your restaurant sent you.</p>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell className="px-4 py-10">
        <h1 className="text-xl font-bold">Link not valid</h1>
        <p className="mt-2 text-sm text-ink-muted">{error}</p>
      </AppShell>
    );
  }

  if (!queue) {
    return <AppShell className="px-4 py-10"><p className="text-sm text-ink-muted">Loading…</p></AppShell>;
  }

  return (
    <AppShell className="px-3 pb-16 pt-6">
      <header className="px-1">
        <p className="text-sm text-ink-muted">{queue.rider.store}</p>
        <h1 className="text-2xl font-extrabold tracking-tight">{queue.rider.name}</h1>
      </header>

      <LocationSharing token={token} />

      {queue.orders.length === 0 ? (
        <p className="mt-6 rounded-2xl bg-surface-edge px-4 py-10 text-center text-sm text-ink-muted">
          Nothing to deliver right now.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {queue.orders.map((order) => (
            <li key={order.id}>
              <Drop order={order} />
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  );
}

/**
 * The switch that shares the rider's position with the customers waiting on them.
 *
 * Opt-in, off by default, and it says in plain words how many people can see them right
 * now — a number they can watch go to zero when the last drop is done. Anything less than
 * that is tracking a worker without telling them, which is not a feature we are building.
 */
function LocationSharing({ token }: { token: string }) {
  const [sharing, setSharing] = useState(false);
  const [sharedWith, setSharedWith] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);
  const lastSent = useRef(0);

  const stop = useCallback(() => {
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    setSharing(false);
    setSharedWith(null);
  }, []);

  // Leaving the page must stop the watch, or the phone keeps a GPS lock alive in the
  // background for a screen nobody is looking at.
  useEffect(() => stop, [stop]);

  const start = () => {
    if (!('geolocation' in navigator)) {
      setError('This phone cannot share its location.');
      return;
    }
    setError(null);
    setSharing(true);
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        // watchPosition fires far more often than we need. Throttling here rather than
        // asking for fewer updates keeps the fix warm while the network use stays flat.
        const now = Date.now();
        if (now - lastSent.current < RIDER_REPORT_INTERVAL_MS) return;
        lastSent.current = now;

        void clientApi<{ accepted: boolean; sharingWith: number }>('/rider/location', {
          method: 'POST',
          body: JSON.stringify({
            token,
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          }),
        })
          .then((res) => setSharedWith(res.sharingWith))
          .catch(() => {
            /* One failed report is a tunnel, not a fault. The next one will land. */
          });
      },
      (err) => {
        setError(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was refused. Turn it on for this site to share.'
            : 'Could not get a location fix.',
        );
        stop();
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
  };

  return (
    <section className={`mt-4 rounded-2xl border p-4 ${sharing ? 'border-brand bg-brand/5' : 'border-surface-line'}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-bold">Share my location</h2>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            {sharing
              ? sharedWith === null
                ? 'Getting a fix…'
                : sharedWith === 0
                  ? 'On — nobody is watching right now.'
                  : `On — visible to ${sharedWith} ${sharedWith === 1 ? 'customer' : 'customers'} on the way.`
              : 'Off. Customers cannot see where you are.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => (sharing ? stop() : start())}
          aria-pressed={sharing}
          className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-bold transition ${
            sharing ? 'bg-brand text-white' : 'border border-surface-line text-brand'
          }`}
        >
          {sharing ? 'Stop' : 'Start'}
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      <p className="mt-2 text-xs text-ink-faint">
        Only customers whose order is out for delivery can see you, and only while it is.
      </p>
    </section>
  );
}

/** One delivery. The address and the cash are the two things that matter at the door. */
function Drop({ order }: { order: RiderOrder }) {
  const addr = order.deliveryAddress ?? {};
  const phone = addr.phone || order.customerPhone;
  const maps =
    typeof addr.lat === 'number' && typeof addr.lng === 'number'
      ? `https://maps.google.com/?q=${addr.lat},${addr.lng}`
      : addr.addressLine
        ? `https://maps.google.com/?q=${encodeURIComponent([addr.addressLine, addr.area, 'Dhaka'].filter(Boolean).join(', '))}`
        : null;

  return (
    <article className="card p-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-sm font-bold">{order.code}</span>
        <span className="rounded-full bg-surface-sunk px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-ink-muted">
          {order.status === 'ON_THE_WAY' ? 'On the way' : 'Ready'}
        </span>
      </div>

      <p className="mt-2 text-[17px] font-semibold leading-snug">{addr.addressLine || '—'}</p>
      {addr.area && <p className="text-sm text-ink-muted">{addr.area}</p>}
      {addr.note && <p className="mt-1 text-sm text-ink-muted">“{addr.note}”</p>}

      {/* The single most expensive mistake on a doorstep is collecting the wrong amount,
          so it is the largest thing on the card — and it says ZERO out loud when the
          order is already paid, rather than leaving a blank the rider has to interpret. */}
      <p className={`mt-3 text-2xl font-extrabold tabular-nums ${order.dueOnDelivery > 0 ? 'text-ink' : 'text-emerald-700'}`}>
        {order.dueOnDelivery > 0 ? formatBDT(order.dueOnDelivery) : 'Paid — collect nothing'}
      </p>

      <div className="mt-3 flex gap-2">
        <a href={`tel:${phone}`} className="btn-ghost flex-1 justify-center gap-1.5">
          <Icon name="phone" size={15} />
          Call
        </a>
        {maps && (
          <a href={maps} target="_blank" rel="noreferrer" className="btn-ghost flex-1 justify-center gap-1.5">
            <Icon name="pin" size={15} />
            Navigate
          </a>
        )}
      </div>
    </article>
  );
}
