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
  /** Which shop this parcel is at. A rider carrying for three cannot collect without it. */
  store: string;
  deliveryAddress: { name?: string; phone?: string; addressLine?: string; area?: string; note?: string; lat?: number | null; lng?: number | null };
}

interface Invite {
  tenantId: string;
  store: string;
}

interface Queue {
  rider: { name: string; shops: number };
  orders: RiderOrder[];
  invites: Invite[];
}

/** A delivery nobody has taken yet. Deliberately thinner than a Drop — see Available. */
interface Offer {
  id: string;
  code: string;
  status: string;
  store: string;
  area: string;
  dueOnDelivery: number;
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
        <p className="text-sm text-ink-muted">
          {queue.rider.shops === 1 ? '1 shop' : `${queue.rider.shops} shops`}
        </p>
        <h1 className="text-2xl font-extrabold tracking-tight">{queue.rider.name}</h1>
      </header>

      <Invites token={token} invites={queue.invites} onAnswered={load} />

      <Money token={token} />

      <Available token={token} onClaimed={load} />

      <LocationSharing token={token} />

      <Run token={token} />

      {queue.orders.length > 0 && (
        <>
          <h2 className="mt-6 px-1 text-xs font-bold uppercase tracking-wide text-ink-faint">
            Carrying now
          </h2>
          <ul className="mt-2 space-y-3">
            {queue.orders.map((order) => (
              <li key={order.id}>
                <Drop order={order} />
              </li>
            ))}
          </ul>
        </>
      )}
    </AppShell>
  );
}

interface Stop {
  id: string;
  seq: number;
  kind: 'PICKUP' | 'DROP';
  done: boolean;
  active: boolean;
  code: string;
  status: string;
  store: string;
  address: string | null;
  phone: string;
  deliveryAddress: RiderOrder['deliveryAddress'] | null;
  dueOnDelivery: number;
}

/**
 * What the rider is carrying and what they have earned.
 *
 * On their own screen because both numbers are about them: one is money they will have to
 * hand over and account for, the other is money they are owed. A rider who can only find
 * out what they owe by asking at the counter is a rider who finds out they were wrong.
 *
 * Cash in hand is the larger of the two on purpose. It is the number that has to reach
 * zero before the day is finished.
 */
function Money({ token }: { token: string }) {
  const [money, setMoney] = useState<{ cash: number; earnings: number } | null>(null);

  const load = useCallback(async () => {
    try {
      setMoney(await clientApi('/rider/money', { method: 'POST', body: JSON.stringify({ token }) }));
    } catch {
      /* one failed poll is a tunnel */
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!money) return null;

  return (
    <section className="mt-4 grid grid-cols-2 gap-2">
      <div className={`rounded-2xl p-4 ${money.cash > 0 ? 'bg-amber-50' : 'bg-surface-sunk'}`}>
        <p className="text-[13px] text-ink-muted">Cash to hand in</p>
        <p className="mt-0.5 text-2xl font-extrabold tabular-nums">{formatBDT(money.cash)}</p>
      </div>
      <div className="rounded-2xl bg-surface-sunk p-4">
        <p className="text-[13px] text-ink-muted">You have earned</p>
        <p className="mt-0.5 text-2xl font-extrabold tabular-nums text-emerald-700">
          {formatBDT(money.earnings)}
        </p>
      </div>
    </section>
  );
}

/**
 * The doorstep.
 *
 * Three things can happen at a door and the screen has to make all three easy, because the
 * two that are not "delivered" are the ones a tired rider will otherwise fake. The code box
 * is first and largest; failing is a plain link, not a hidden gesture; and taking the
 * parcel back is only offered **after** an attempt has been recorded, so "returned" always
 * has a reason behind it.
 */
function Handover({
  busy,
  onDeliver,
  onFail,
  onReturn,
}: {
  busy: boolean;
  onDeliver: (otp: string) => Promise<void> | void;
  onFail: (reason: string, note: string) => Promise<void> | void;
  onReturn: () => Promise<void> | void;
}) {
  const [otp, setOtp] = useState('');
  const [failing, setFailing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [reason, setReason] = useState('NO_ANSWER');
  const [note, setNote] = useState('');

  const reasons: { value: string; label: string }[] = [
    { value: 'NO_ANSWER', label: 'Nobody answered' },
    { value: 'WRONG_ADDRESS', label: 'Address is wrong' },
    { value: 'REFUSED', label: 'Customer refused it' },
    { value: 'NO_CASH', label: 'Customer had no cash' },
    { value: 'OTHER', label: 'Something else' },
  ];

  if (failing) {
    return (
      <div className="mt-3 rounded-xl bg-surface-sunk p-3">
        <p className="text-sm font-bold">What happened?</p>
        <div className="mt-2 space-y-1.5">
          {reasons.map((r) => (
            <label key={r.value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="fail-reason"
                checked={reason === r.value}
                onChange={() => setReason(r.value)}
              />
              {r.label}
            </label>
          ))}
        </div>
        <input
          className="field mt-2 w-full text-sm"
          placeholder="Anything to add (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              await onFail(reason, note);
              setFailing(false);
              setAttempted(true);
              setNote('');
            }}
            className="flex-1 rounded-full bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
          >
            Save and move on
          </button>
          <button
            type="button"
            onClick={() => setFailing(false)}
            className="rounded-full border border-surface-line px-4 py-2.5 text-sm font-bold text-ink-muted"
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        {/* Left blank when the shop does not ask for a code — the server decides, and an
            empty box costs nothing. Typing one where none is required is simply ignored. */}
        <input
          className="field w-28 text-center text-lg font-bold tracking-[0.3em]"
          inputMode="numeric"
          maxLength={6}
          placeholder="Code"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onDeliver(otp)}
          className="flex-1 rounded-full bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
        >
          Delivered
        </button>
      </div>
      <div className="mt-2 flex items-center gap-4">
        <button
          type="button"
          onClick={() => setFailing(true)}
          className="text-sm font-semibold text-ink-muted underline"
        >
          Couldn’t deliver
        </button>
        {attempted && (
          <button
            type="button"
            disabled={busy}
            onClick={onReturn}
            className="text-sm font-semibold text-red-700 underline disabled:opacity-60"
          >
            Take it back to the shop
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The run: every counter and every door, in the order they should be visited.
 *
 * Only the **next** stop can be acted on. That is not a UI simplification — a rider who
 * can tick the third drop from the first one's gate leaves two customers whose tracker
 * says delivered and whose food is still in the bag. The rest of the list is there to be
 * read, not tapped, so the rider knows what is coming.
 */
function Run({ token }: { token: string }) {
  const [trip, setTrip] = useState<{ id: string; status: string; remaining: number } | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (res: { trip: any; stops: Stop[] }) => {
    setTrip(res.trip);
    setStops(res.stops);
  };

  const load = useCallback(async () => {
    try {
      apply(await clientApi('/rider/trip', { method: 'POST', body: JSON.stringify({ token }) }));
    } catch {
      /* one failed poll is a tunnel */
    }
  }, [token]);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const call = async (
    path: 'trip/plan' | 'trip/stop' | 'trip/failed' | 'trip/return',
    body: Record<string, unknown> = {},
  ) => {
    setBusy(path);
    setError(null);
    try {
      apply(await clientApi(`/rider/${path}`, { method: 'POST', body: JSON.stringify({ token, ...body }) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not go through.');
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!trip || stops.length === 0) return null;
  const active = stops.find((s) => s.active);

  return (
    <section className="mt-6">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 className="text-xs font-bold uppercase tracking-wide text-ink-faint">Your run</h2>
        <span className="text-xs text-ink-faint">{trip.remaining} left</span>
      </div>

      {trip.status === 'PLANNED' && (
        <button
          type="button"
          onClick={() => call('trip/plan', {})}
          disabled={busy !== null}
          className="mt-2 w-full rounded-full bg-brand px-4 py-3 text-sm font-bold text-white disabled:opacity-60"
        >
          Sort my route and start
        </button>
      )}

      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {error}
        </p>
      )}

      <ol className="mt-2 space-y-2">
        {stops.map((stop) => {
          const addr = stop.deliveryAddress ?? {};
          const maps =
            stop.kind === 'DROP' && typeof addr.lat === 'number' && typeof addr.lng === 'number'
              ? `https://maps.google.com/?q=${addr.lat},${addr.lng}`
              : null;

          return (
            <li
              key={stop.id}
              className={`card p-4 ${stop.done ? 'opacity-50' : ''} ${
                stop.active ? 'border-brand ring-1 ring-brand' : ''
              }`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                  {stop.kind === 'PICKUP' ? 'Collect' : 'Deliver'} · {stop.code}
                </span>
                {stop.done && <span className="text-[11px] font-bold text-emerald-700">Done ✓</span>}
              </div>

              <p className="mt-1 flex items-center gap-1.5 text-[15px] font-bold">
                <Icon name="pin" size={14} />
                {stop.kind === 'PICKUP' ? stop.store : addr.addressLine || addr.area || '—'}
              </p>
              {stop.kind === 'PICKUP'
                ? stop.address && <p className="text-sm text-ink-muted">{stop.address}</p>
                : addr.area && <p className="text-sm text-ink-muted">{addr.area}</p>}
              {stop.kind === 'DROP' && addr.note && (
                <p className="mt-1 text-sm text-ink-muted">“{addr.note}”</p>
              )}

              {stop.kind === 'DROP' && (
                <p
                  className={`mt-2 text-xl font-extrabold tabular-nums ${
                    stop.dueOnDelivery > 0 ? 'text-ink' : 'text-emerald-700'
                  }`}
                >
                  {stop.dueOnDelivery > 0 ? formatBDT(stop.dueOnDelivery) : 'Paid — collect nothing'}
                </p>
              )}

              {!stop.done && (
                <div className="mt-3 flex gap-2">
                  <a href={`tel:${stop.phone}`} className="btn-ghost justify-center gap-1.5 px-4">
                    <Icon name="phone" size={15} />
                    Call
                  </a>
                  {maps && (
                    <a href={maps} target="_blank" rel="noreferrer" className="btn-ghost justify-center gap-1.5 px-4">
                      <Icon name="pin" size={15} />
                      Go
                    </a>
                  )}
                  {stop.active && stop.kind === 'PICKUP' && (
                    <button
                      type="button"
                      onClick={() => call('trip/stop', { stopId: stop.id })}
                      disabled={busy !== null}
                      className="flex-1 rounded-full bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
                    >
                      Got it
                    </button>
                  )}
                </div>
              )}

              {stop.active && stop.kind === 'DROP' && !stop.done && (
                <Handover
                  busy={busy !== null}
                  onDeliver={(otp) => call('trip/stop', { stopId: stop.id, otp })}
                  onFail={(reason, note) => call('trip/failed', { stopId: stop.id, reason, note })}
                  onReturn={() => call('trip/return', { stopId: stop.id })}
                />
              )}
            </li>
          );
        })}
      </ol>

      {!active && trip.remaining > 0 && (
        <p className="mt-2 px-1 text-xs text-ink-faint">Tap “Sort my route and start” to begin.</p>
      )}
    </section>
  );
}

/**
 * Work waiting in this rider's own villages, and the switch that turns it on.
 *
 * The duty toggle and the list live together on purpose: "am I working" and "what is there
 * to do" are one question to the person holding the phone, and splitting them across two
 * screens is how a rider ends up off duty all morning without noticing.
 *
 * An offer shows the shop, the village and the cash — enough to decide — and no street
 * address, because everyone on duty can read this list. The address arrives with the job.
 */
function Available({ token, onClaimed }: { token: string; onClaimed: () => Promise<void> | void }) {
  const [onDuty, setOnDuty] = useState(false);
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await clientApi<{ onDuty: boolean; offers: Offer[] }>('/rider/available', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setOnDuty(res.onDuty);
      setOffers(res.offers);
    } catch {
      /* One failed poll is a tunnel. The next one lands. */
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    // Shorter than the run sheet's minute: this is the list people are racing on, and a
    // card that has already gone is worse than a slightly emptier screen.
    const timer = setInterval(refresh, 20_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const setDuty = async (next: boolean) => {
    setBusy('duty');
    try {
      await clientApi('/rider/duty', { method: 'POST', body: JSON.stringify({ token, onDuty: next }) });
      setOnDuty(next);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const act = async (offer: Offer, path: 'accept' | 'skip') => {
    setBusy(offer.id);
    setNote(null);
    try {
      await clientApi(`/rider/${path}`, {
        method: 'POST',
        body: JSON.stringify({ token, orderId: offer.id }),
      });
      await Promise.all([refresh(), onClaimed()]);
    } catch (err) {
      // Losing a race is the ordinary outcome here, not a fault — so it is said plainly
      // and the list is refreshed underneath, rather than left showing a card that is gone.
      setNote(err instanceof Error ? err.message : 'That did not go through.');
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-4">
      <div
        className={`flex items-center justify-between gap-3 rounded-2xl border p-4 ${
          onDuty ? 'border-emerald-500/50 bg-emerald-50' : 'border-surface-line'
        }`}
      >
        <div className="min-w-0">
          <h2 className="font-bold">{onDuty ? 'On duty' : 'Off duty'}</h2>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            {onDuty
              ? offers.length === 0
                ? 'Nothing waiting in your area right now.'
                : `${offers.length} ${offers.length === 1 ? 'delivery' : 'deliveries'} waiting in your area.`
              : 'You will not be offered any new deliveries.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDuty(!onDuty)}
          disabled={busy === 'duty'}
          aria-pressed={onDuty}
          className={`shrink-0 rounded-full px-4 py-2.5 text-sm font-bold transition disabled:opacity-60 ${
            onDuty ? 'bg-emerald-600 text-white' : 'border border-surface-line text-brand'
          }`}
        >
          {onDuty ? 'Go off' : 'Go on duty'}
        </button>
      </div>

      {note && (
        <p role="alert" className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {note}
        </p>
      )}

      {onDuty && offers.length > 0 && (
        <ul className="mt-3 space-y-2">
          {offers.map((offer) => (
            <li key={offer.id} className="card p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-mono text-sm font-bold">{offer.code}</span>
                <span className="text-[11px] font-bold uppercase tracking-wide text-ink-faint">
                  {offer.status === 'READY' ? 'Ready now' : 'Being prepared'}
                </span>
              </div>

              <p className="mt-1 flex items-center gap-1.5 text-[15px] font-bold text-brand">
                <Icon name="pin" size={14} />
                {offer.store}
              </p>
              {/* The village, not the door. Enough to say yes or no; the rest comes after. */}
              <p className="text-sm text-ink-muted">to {offer.area || 'an unnamed area'}</p>

              <p className="mt-2 text-xl font-extrabold tabular-nums">
                {offer.dueOnDelivery > 0 ? `Collect ${formatBDT(offer.dueOnDelivery)}` : 'Already paid'}
              </p>

              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  disabled={busy === offer.id}
                  onClick={() => act(offer, 'accept')}
                  className="flex-1 rounded-full bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
                >
                  Take it
                </button>
                <button
                  type="button"
                  disabled={busy === offer.id}
                  onClick={() => act(offer, 'skip')}
                  className="rounded-full border border-surface-line px-4 py-2.5 text-sm font-bold text-ink-muted disabled:opacity-60"
                >
                  Pass
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Shops asking to work with this rider.
 *
 * This is a consent step, not a notification. A shop that could add a rider by typing
 * their phone number would be handed this link — and this link opens the sheet below,
 * with every other shop's customers and addresses on it. So the shop asks, and the rider
 * is the one who says yes.
 *
 * It needs no login because the rider is already holding the only proof of who they are.
 */
function Invites({
  token,
  invites,
  onAnswered,
}: {
  token: string;
  invites: Invite[];
  onAnswered: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  if (invites.length === 0) return null;

  const answer = async (tenantId: string, accept: boolean) => {
    setBusy(tenantId);
    try {
      await clientApi('/rider/invites', {
        method: 'POST',
        body: JSON.stringify({ token, tenantId, accept }),
      });
      await onAnswered();
    } catch {
      // Left on screen to try again — a failed tap here must not look like a decision.
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-4 space-y-2">
      {invites.map((invite) => (
        <article key={invite.tenantId} className="rounded-2xl border border-brand/40 bg-brand/5 p-4">
          <p className="text-[15px] font-semibold leading-snug">
            <span className="font-extrabold">{invite.store}</span> wants you to deliver for them.
          </p>
          <p className="mt-1 text-[13px] text-ink-muted">
            Accept and their deliveries appear on this same sheet.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy === invite.tenantId}
              onClick={() => answer(invite.tenantId, true)}
              className="flex-1 rounded-full bg-brand px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={busy === invite.tenantId}
              onClick={() => answer(invite.tenantId, false)}
              className="flex-1 rounded-full border border-surface-line px-4 py-2.5 text-sm font-bold text-ink-muted disabled:opacity-60"
            >
              No thanks
            </button>
          </div>
        </article>
      ))}
    </section>
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

      {/* Which counter to collect from. Sits above the address because on a multi-shop
          run the pickup is the part the rider gets wrong, not the drop. */}
      {order.store && (
        <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold text-brand">
          <Icon name="pin" size={13} />
          {order.store}
        </p>
      )}

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
