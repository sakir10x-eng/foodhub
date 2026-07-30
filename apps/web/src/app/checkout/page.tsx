'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { formatBDT, matchZone, requiresLocation, splitPayment, type PublicTenant } from '@foodhub/shared';
import { MapPicker, type GeoPlace } from '@foodhub/mapkit';
import { clientApi, ApiError } from '../../lib/client';
import { LoyaltyPanel, type LoyaltyState } from '../../components/Loyalty';
import { Icon } from '../../components/Icon';
import { AppShell } from '../../components/AppShell';
import { lineKey, useCart, useCustomer, type SavedCustomer } from '../../lib/cart';

const DHAKA_AREAS = ['Dhanmondi', 'Gulshan', 'Banani', 'Uttara', 'Mirpur', 'Mohammadpur', 'Bashundhara', 'Other'];

/**
 * Checkout.
 *
 * The whole design goal is ≤3 taps for a returning customer: the address is restored
 * from the last order, cash-on-delivery is preselected, and "Place order" is one tap
 * away. A first-time customer fills the form once and never again.
 */
export default function CheckoutPage() {
  const router = useRouter();
  const { lines, tenantId, tenantName, tenantSlug, fulfillment, setQty, clear, subtotal } = useCart();
  const saved = useCustomer((s) => s.saved);
  const saveCustomer = useCustomer((s) => s.save);

  const [mounted, setMounted] = useState(false);
  const [form, setForm] = useState<SavedCustomer>({
    name: '', phone: '', addressLine: '', area: 'Dhanmondi', city: 'Dhaka', note: '', lat: null, lng: null,
  });
  const [method, setMethod] = useState<'COD' | 'SSLCOMMERZ'>('COD');
  const [store, setStore] = useState<PublicTenant | null>(null);
  const [scheduledFor, setScheduledFor] = useState<string>('');
  const [coupon, setCoupon] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingAddress, setEditingAddress] = useState(false);
  const [loyalty, setLoyalty] = useState<LoyaltyState>({ redeemPoints: 0, useWallet: false, discount: 0 });

  useEffect(() => {
    setMounted(true);
    if (saved) setForm(saved);
    else setEditingAddress(true);
  }, [saved]);

  // Which channel we are on decides the endpoint — and therefore whose gateway takes
  // the money and whether a commission is charged.
  const isMarketplace = useMemo(() => {
    if (typeof window === 'undefined') return false;
    const marketplaceHost = (process.env.NEXT_PUBLIC_MARKETPLACE_HOST ?? 'lvh.me:3000').split(':')[0];
    const host = window.location.hostname;
    return host === marketplaceHost || host === `www.${marketplaceHost}`;
  }, []);

  /*
   * The vendor's delivery zones and payment rules.
   *
   * Fetched rather than carried in the cart because both are vendor settings that can
   * change between adding an item and paying for it — and the one that decides how much
   * money is demanded up front must not be a stale copy from an hour ago. The server
   * re-derives everything at order time regardless; this is purely so the customer is not
   * surprised at the last tap.
   */
  useEffect(() => {
    if (!mounted || !tenantId) return;
    const path = isMarketplace ? `/marketplace/vendors/${tenantSlug}` : '/storefront/menu';
    let live = true;
    clientApi<{ tenant: PublicTenant }>(path)
      .then((r) => live && setStore(r.tenant))
      .catch(() => {
        // A failed lookup must not block checkout: the server is the authority on both
        // the fee and the advance, so the worst case is the summary stays vague.
      });
    return () => { live = false; };
  }, [mounted, tenantId, tenantSlug, isMarketplace]);

  const goods = subtotal();

  /*
   * Hand the basket to the server once a valid phone number exists.
   *
   * Debounced and fired on the number, not on every keystroke of the address: this is the
   * first moment there is somebody to remind, and it is also the last moment before the
   * customer might close the tab. Failure is silent — a recovery feature must never be
   * the reason a checkout shows an error.
   */
  useEffect(() => {
    if (!mounted || !tenantId || lines.length === 0) return;
    if (!/^01[3-9]\d{8}$/.test(form.phone.replace(/\D/g, ''))) return;

    const timer = setTimeout(() => {
      void clientApi('/storefront/cart/remember', {
        method: 'POST',
        body: JSON.stringify({
          phone: form.phone,
          items: lines.map((l) => ({ productId: l.productId, name: l.name, qty: l.qty, price: l.price })),
          subtotal: goods,
        }),
      }).catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [mounted, tenantId, form.phone, lines, goods]);

  // A collected order has no rider leg, so no zone is resolved and no fee is charged.
  // The server derives this again from the same flag — this is only so the summary the
  // customer approves matches the one they are billed for.
  const pickup = fulfillment === 'PICKUP' && Boolean(store?.pickupEnabled);

  /*
   * Where this is going, and whether the vendor goes there.
   *
   * The same `matchZone` the API runs when the order is placed, so the fee shown here and
   * the fee charged there come from one rule. The pin wins over the area dropdown when
   * there is one — a customer who dropped a marker on their gate has told us something
   * more precise than "Mirpur".
   */
  const pin = form.lat != null && form.lng != null ? { lat: form.lat, lng: form.lng } : null;
  const zones = store?.deliveryZones ?? [];
  const match = pickup || !store
    ? { zone: null, outsideServiceArea: false }
    : matchZone(zones, { area: form.area, point: pin });
  const zone = match.zone;
  /** The vendor draws a boundary and this address is outside it. */
  const outsideArea = match.outsideServiceArea && !!pin;
  /** The vendor delivers by map and we have no pin yet, so nothing can be priced. */
  const needsPin = !pickup && !!store && requiresLocation(zones) && !pin;
  const deliveryFee = pickup ? 0 : (zone?.fee ?? null);
  const estimatedTotal = Math.max(0, goods - loyalty.discount) + (deliveryFee ?? 0);
  const split = store
    ? splitPayment(estimatedTotal, goods, store.payment ?? { codEnabled: true, advancePercent: 0, advanceThreshold: 0 })
    : null;
  const codBlocked = Boolean(split && !split.codAllowed);
  const belowMinimum = Boolean(zone && zone.minOrder > 0 && goods < zone.minOrder);

  // Cash is preselected, so an advance rule has to move the selection itself — leaving a
  // disabled option checked would let the customer press a button the server will reject.
  useEffect(() => {
    if (codBlocked && method === 'COD') setMethod('SSLCOMMERZ');
  }, [codBlocked, method]);

  if (!mounted) return <CheckoutSkeleton />;

  if (lines.length === 0) {
    return (
      <AppShell className="grid place-items-center px-6 text-center">
        <div>
          <h1 className="text-lg font-bold">Your basket is empty</h1>
          <p className="mt-1 text-sm text-ink-muted">Add something you fancy and come back.</p>
          <Link href="/" className="btn-brand mt-5">Browse the menu</Link>
        </div>
      </AppShell>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const payload = {
        ...(isMarketplace ? { tenantId } : {}),
        items: lines.map((l) => ({
          productId: l.productId,
          qty: l.qty,
          // Option IDs only. The server re-prices from its own rows, so nothing here can
          // change what the order costs.
          ...(l.optionIds?.length ? { optionIds: l.optionIds } : {}),
        })),
        address: {
          name: form.name, phone: form.phone, addressLine: form.addressLine,
          area: form.area, city: form.city, note: form.note,
          lat: form.lat ?? null, lng: form.lng ?? null,
        },
        fulfillment: pickup ? 'PICKUP' : 'DELIVERY',
        ...(scheduledFor ? { scheduledFor: new Date(scheduledFor).toISOString() } : {}),
        paymentMethod: method,
        ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
        ...(loyalty.redeemPoints > 0 ? { redeemPoints: loyalty.redeemPoints } : {}),
        ...(loyalty.useWallet ? { useWallet: true } : {}),
      };

      const result = await clientApi<{
        order: { id: string; code: string; total: number };
        payment: { redirectUrl: string | null; provider: string };
      }>(isMarketplace ? '/marketplace/checkout' : '/storefront/checkout', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      // Remember the address so the next order really is three taps.
      saveCustomer(form);
      clear();

      if (result.payment.redirectUrl) {
        const url = result.payment.redirectUrl;
        window.location.href = url.startsWith('http')
          ? url
          : `${url}?order=${result.order.code}&phone=${encodeURIComponent(form.phone)}`;
        return;
      }
      router.push(`/order/${result.order.code}?phone=${encodeURIComponent(form.phone)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not place the order. Please try again.');
      setBusy(false);
    }
  };

  return (
    <AppShell className="pb-40">
      <header className="flex items-center gap-3 border-b border-surface-line px-4 py-4">
        <Link href="/" aria-label="Back" className="grid h-9 w-9 place-items-center rounded-full bg-surface-sunk">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div>
          <h1 className="text-lg font-bold leading-tight">Checkout</h1>
          {tenantName && <p className="text-xs text-ink-muted">from {tenantName}</p>}
        </div>
      </header>

      <form onSubmit={submit}>
        <section className="border-b-8 border-surface-sunk px-4 py-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-faint">Your order</h2>
          <ul className="space-y-3">
            {lines.map((line) => (
              <li key={lineKey(line)} className="flex items-center gap-3">
                <div className="flex items-center gap-1 rounded-full border border-surface-line px-1">
                  <button type="button" onClick={() => setQty(lineKey(line), line.qty - 1)}
                          aria-label={`One less ${line.name}`}
                          className="grid h-7 w-7 place-items-center rounded-full text-ink-muted active:scale-90">−</button>
                  <span className="w-4 text-center text-sm font-bold tabular-nums">{line.qty}</span>
                  <button type="button" onClick={() => setQty(lineKey(line), line.qty + 1)}
                          aria-label={`One more ${line.name}`}
                          className="grid h-7 w-7 place-items-center rounded-full text-brand active:scale-90">+</button>
                </div>
                <span className="min-w-0 flex-1 text-sm">
                  <span className="block truncate">{line.name}</span>
                  {(line.modifierSummary || line.comboName) && (
                    <span className="block truncate text-[11.5px] text-ink-faint">
                      {[line.comboName, line.modifierSummary].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
                <span className="text-sm font-semibold tabular-nums">{formatBDT(line.price * line.qty)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="border-b-8 border-surface-sunk px-4 py-5">
          {pickup && (
            <p className="mb-3 flex items-start gap-2 rounded-xl bg-surface-sunk px-3 py-2.5 text-[13px]">
              <Icon name="bag" size={15} className="mt-0.5 shrink-0 text-brand" strokeWidth={2.2} />
              <span>
                <b>Collecting from the counter.</b>
                {store?.address && <span className="block text-ink-muted">{store.address}</span>}
                <span className="block text-ink-faint">
                  Ready in about {store?.pickupMinutes ?? 15} minutes. No delivery fee.
                </span>
              </span>
            </p>
          )}
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-ink-faint">
              {pickup ? 'Who is collecting' : 'Delivery to'}
            </h2>
            {saved && !editingAddress && (
              <button type="button" onClick={() => setEditingAddress(true)}
                      className="text-sm font-semibold text-brand">Change</button>
            )}
          </div>

          {saved && !editingAddress && !pickup ? (
            <div className="rounded-xl bg-surface-sunk p-3 text-sm">
              <p className="font-semibold">{form.name} · {form.phone}</p>
              <p className="mt-0.5 text-ink-muted">{form.addressLine}, {form.area}, {form.city}</p>
            </div>
          ) : (
            <div className="space-y-3">
              <input required minLength={2} className="field" placeholder="Your name" autoComplete="name"
                     value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input required className="field" placeholder="01XXXXXXXXX" type="tel" inputMode="numeric"
                     autoComplete="tel" value={form.phone}
                     onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              {/* Asking someone walking to the counter for their street is friction with
                  no purpose — the server discards it on a pickup order anyway. */}
              {!pickup && (
                <>
                  {/*
                    The pin, above the text box rather than below it.

                    "House 12, Road 4" is four different places in Dhaka and a rider
                    ringing to ask which one is the single most common reason a delivery
                    runs late. Dropping a marker takes one thumb and settles it — and for
                    a vendor who has drawn a delivery area, it is also the only way we can
                    honestly tell the customer whether they are inside it.
                  */}
                  <MapPicker
                    value={pin}
                    origin={store?.lat != null && store?.lng != null ? { lat: store.lat, lng: store.lng } : null}
                    onChange={(point, place) => setForm((f) => ({
                      ...f,
                      lat: point.lat,
                      lng: point.lng,
                      // The typed address wins: the geocoder knows the road, the customer
                      // knows which gate. Only ever used to fill blanks.
                      addressLine: f.addressLine.trim() ? f.addressLine : (place?.addressLine ?? ''),
                      area: place?.area?.trim() ? place.area : f.area,
                      city: place?.city?.trim() ? place.city : f.city,
                    }))}
                    footer={<AreaVerdict outside={outsideArea} needsPin={needsPin} zone={zone} store={store} />}
                  />
                  <input required minLength={5} className="field" placeholder="House, road, flat"
                         autoComplete="street-address" value={form.addressLine}
                         onChange={(e) => setForm({ ...form, addressLine: e.target.value })} />
                  <select className="field" value={form.area}
                          onChange={(e) => setForm({ ...form, area: e.target.value })}>
                    {DHAKA_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                </>
              )}
              <input className="field" placeholder={pickup ? 'Note for the kitchen (optional)' : 'Note for the rider (optional)'}
                     value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
          )}
        </section>

        {store?.schedulingEnabled && (
          <section className="border-b-8 border-surface-sunk px-4 py-5">
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-faint">When</h2>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setScheduledFor('')}
                aria-pressed={!scheduledFor}
                className={`flex-1 rounded-xl border p-3 text-left transition ${
                  !scheduledFor ? 'border-brand bg-brand/5' : 'border-surface-line'
                }`}
              >
                <span className="block text-sm font-semibold">As soon as possible</span>
                <span className="block text-xs text-ink-muted">
                  ~{pickup ? store.pickupMinutes : store.prepMinutes} min
                </span>
              </button>
              <label
                className={`flex-1 cursor-pointer rounded-xl border p-3 transition ${
                  scheduledFor ? 'border-brand bg-brand/5' : 'border-surface-line'
                }`}
              >
                <span className="block text-sm font-semibold">Later</span>
                <input
                  type="datetime-local"
                  className="mt-1 w-full bg-transparent text-xs text-ink-muted outline-none"
                  /* The kitchen still needs its prep time, so the picker cannot offer
                     "in five minutes" — the server enforces the same floor. */
                  min={localInput(Date.now() + store.prepMinutes * 60_000)}
                  max={localInput(Date.now() + store.schedulingMaxDays * 86_400_000)}
                  value={scheduledFor}
                  onChange={(e) => setScheduledFor(e.target.value)}
                />
              </label>
            </div>
          </section>
        )}

        <section className="border-b-8 border-surface-sunk px-4 py-5">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-ink-faint">Payment</h2>
          {/*
            Why the money is being asked for up front. Stated plainly and without apology:
            a customer who understands the reason accepts it, and a vague "advance
            required" reads as a scam.
          */}
          {split?.advanceRequired && (
            <p className="mb-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
              <Icon name="lock" size={15} className="mt-0.5 shrink-0" strokeWidth={2.2} />
              <span>
                <b>{formatBDT(split.advanceAmount)} due now.</b>{' '}
                {split.dueOnDelivery > 0
                  ? <>The rider collects the remaining {formatBDT(split.dueOnDelivery)} in cash.</>
                  : <>This kitchen cooks to order, so it takes payment before starting.</>}
              </span>
            </p>
          )}

          <div className="space-y-2">
            {([
              ['COD', 'Cash on delivery', 'Pay the rider when it arrives'],
              ['SSLCOMMERZ', 'Card / bKash / Nagad', split?.advanceRequired ? `Pay ${formatBDT(split.advanceAmount)} now, securely` : 'Pay now, securely'],
            ] as const).map(([value, label, hint]) => {
              const disabled = value === 'COD' && codBlocked;
              return (
                <label key={value}
                       className={`flex items-start gap-3 rounded-xl border p-3 transition ${
                         disabled
                           ? 'cursor-not-allowed border-surface-line bg-surface-sunk opacity-60'
                           : method === value ? 'cursor-pointer border-brand bg-brand/5' : 'cursor-pointer border-surface-line'}`}>
                  <input type="radio" name="pay" value={value} checked={method === value} disabled={disabled}
                         onChange={() => setMethod(value)} className="mt-1 accent-[rgb(var(--brand))]" />
                  <span>
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-ink-muted">
                      {disabled ? 'Not available for this order' : hint}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <input className="field mt-3" placeholder="Promo code (optional)" value={coupon}
                 onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
        </section>

        <LoyaltyPanel phone={form.phone} subtotal={goods} value={loyalty} onChange={setLoyalty} />

        {error && (
          <p role="alert" className="mx-4 mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        )}

        <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-[460px] border-t border-surface-line bg-white/95 px-4 pb-[max(12px,env(safe-area-inset-bottom))] pt-3 shadow-bar backdrop-blur">
          <dl className="mb-2 space-y-1 text-sm">
            <div className="flex justify-between text-ink-muted">
              <dt>Subtotal</dt>
              <dd className="tabular-nums">{formatBDT(goods)}</dd>
            </div>
            <div className="flex justify-between text-ink-muted">
              <dt>{pickup ? 'Pickup' : `Delivery${zone ? ` · ${zone.label}` : ''}`}</dt>
              {/* The server re-resolves the zone at order time; this is the same rule. */}
              <dd className="tabular-nums">
                {deliveryFee === null
                  ? <span className="text-xs">calculated at confirmation</span>
                  : deliveryFee === 0
                    ? <span className="font-semibold text-emerald-700">{pickup ? 'No fee' : 'Free'}</span>
                    : formatBDT(deliveryFee)}
              </dd>
            </div>
            {loyalty.discount > 0 && (
              <div className="flex justify-between text-emerald-700">
                <dt>Rewards</dt>
                <dd className="tabular-nums">−{formatBDT(loyalty.discount)}</dd>
              </div>
            )}
            {split && split.dueOnDelivery > 0 && split.advanceRequired && (
              <div className="flex justify-between border-t border-surface-line pt-1 text-ink-muted">
                <dt className="flex items-center gap-1.5"><Icon name="cash" size={13} /> Cash on delivery</dt>
                <dd className="tabular-nums">{formatBDT(split.dueOnDelivery)}</dd>
              </div>
            )}
          </dl>

          {belowMinimum && zone && (
            <p role="alert" className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
              {zone.label} has a {formatBDT(zone.minOrder)} minimum — add {formatBDT(zone.minOrder - goods)} more.
            </p>
          )}

          {/* The address is out of range, or there is no pin to judge. Either way the
              button is stopped here rather than letting the server refuse the order after
              the customer has committed to paying. */}
          {(outsideArea || needsPin) && (
            <p role="alert" className={`mb-2 rounded-lg px-3 py-2 text-xs font-semibold ${
              outsideArea ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-900'
            }`}>
              {outsideArea
                ? 'This address is outside the delivery area — move the pin or switch to pickup.'
                : 'Set your location on the map to continue.'}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || belowMinimum || outsideArea || needsPin}
            className="btn-brand w-full justify-between"
          >
            <span>
              {busy
                ? 'Placing order…'
                : split?.advanceRequired && method !== 'COD'
                  ? `Pay ${formatBDT(split.advanceAmount)}`
                  : 'Place order'}
            </span>
            <span className="tabular-nums">
              {deliveryFee === null ? `${formatBDT(Math.max(0, goods - loyalty.discount))}+` : formatBDT(estimatedTotal)}
            </span>
          </button>
        </div>
      </form>
    </AppShell>
  );
}

/**
 * What the map just told us about this address.
 *
 * Said here, next to the pin, rather than at the bottom of the page when the order is
 * refused: a customer who is outside the delivery area should find that out before they
 * type their phone number, not after they press pay.
 */
function AreaVerdict({
  outside, needsPin, zone, store,
}: {
  outside: boolean;
  needsPin: boolean;
  zone: { label: string; fee: number } | null;
  store: PublicTenant | null;
}) {
  if (outside) {
    return (
      <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2.5 text-[13px] font-semibold text-red-700">
        {store?.name ?? 'This restaurant'} does not deliver to this location yet. Move the pin
        closer, or switch to pickup.
      </p>
    );
  }
  if (needsPin) {
    return (
      <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2.5 text-[13px] font-semibold text-amber-800">
        Move the map so the pin is on your address — this restaurant delivers to a set area.
      </p>
    );
  }
  if (zone) {
    return (
      <p className="mt-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-[13px] font-semibold text-emerald-800">
        Delivers here · {zone.label} · {formatBDT(zone.fee)}
      </p>
    );
  }
  return null;
}

function CheckoutSkeleton() {
  return (
    <AppShell className="space-y-4 px-4 py-6">
      <div className="skeleton h-6 w-32" />
      <div className="skeleton h-24 w-full rounded-xl" />
      <div className="skeleton h-40 w-full rounded-xl" />
      <div className="skeleton h-28 w-full rounded-xl" />
    </AppShell>
  );
}

/** `datetime-local` wants local wall-clock text, not an ISO instant. */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
