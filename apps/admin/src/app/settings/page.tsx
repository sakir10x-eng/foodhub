'use client';

import { useCallback, useEffect, useState } from 'react';
import { PLAN_FEATURES, taka, type DeliveryZone, type Entitlements } from '@foodhub/shared';
import { adminApi } from '../../lib/auth';
import { Banner, PageHeader, Shell } from '../../components/Shell';
import { DeliveryZones } from '../../components/DeliveryZones';
import { PaymentPolicy } from '../../components/PaymentPolicy';
import { PlanLock } from '../../components/PlanLock';
import { OpeningHours } from '../../components/OpeningHours';

interface Settings {
  id: string; slug: string; name: string; tagline: string; brandColor: string;
  phone: string; address: string; lat: number | null; lng: number | null;
  isOpen: boolean; listedOnMarketplace: boolean; prepMinutes: number;
  commissionRateBps: number; plan: string; planStatus: string;
  loyaltyEnabled: boolean; pointsPerHundred: number; pointValue: number; minRedeemPoints: number;
  aiAssistantEnabled: boolean; aiPersona: string;
  codEnabled: boolean; advancePercent: number; advanceThreshold: number;
  pickupEnabled: boolean; pickupMinutes: number;
  schedulingEnabled: boolean; schedulingMaxDays: number;
  metaPixelId: string; tiktokPixelId: string; ga4MeasurementId: string;
  openingHours: { day: number; open: string; close: string }[]; autoOpenClose: boolean;
  referralEnabled: boolean; referrerReward: number; refereeReward: number; referralMinSpend: number;
  deliveryZones: DeliveryZone[];
  gateway: { provider: string; configured: boolean; sandbox: boolean; hint: string };
  sms: { configured: boolean; senderId: string };
  /** Server's answer to "can this store collect an advance?" — see tenant.service.ts. */
  canRequireAdvance: boolean;
  entitlements: Entitlements;
}

export default function SettingsPage() {
  return (
    <Shell>
      <StoreSettings />
    </Shell>
  );
}

function StoreSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(await adminApi<Settings>('/vendor/settings'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (!settings) {
    return (
      <>
        <PageHeader title="Store" />
        <div className="space-y-3 p-4">
          {[0, 1, 2].map((i) => <div key={i} className="skeleton h-24 w-full rounded-2xl" />)}
        </div>
      </>
    );
  }

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await adminApi('/vendor/settings', { method: 'PATCH', body: JSON.stringify(body) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Same write as `patch`, but the error is thrown rather than parked in the page banner —
   * the zone and payment editors show it inline, next to the control that caused it.
   */
  const patchOrThrow = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await adminApi('/vendor/settings', { method: 'PATCH', body: JSON.stringify(body) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const setListing = async (value: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await adminApi('/vendor/marketplace-listing', { method: 'POST', body: JSON.stringify({ value }) });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Store" action={saved ? <span className="text-sm text-emerald-700">Saved</span> : null} />

      <div className="max-w-2xl space-y-6 p-4">
        {error && <Banner tone="error">{error}</Banner>}
        {settings.planStatus === 'SUSPENDED' && (
          <Banner tone="error">
            Your storefront is suspended for non-payment. Settle the outstanding invoice to bring it back online.
          </Banner>
        )}
        {settings.planStatus === 'PAST_DUE' && (
          <Banner tone="warn">An invoice is overdue. Your storefront stays live for now, but not indefinitely.</Banner>
        )}

        {/*
          The Mode B switch. This is the strategic hinge of the whole product: the vendor
          already has a catalog from running their own store, so joining the marketplace
          is one toggle rather than an onboarding project.
        */}
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">FoodHub marketplace</h2>
              <p className="mt-1 text-sm text-ink-muted">
                List your menu on the FoodHub marketplace as well as your own site. Orders land in
                the same queue; we take {(settings.commissionRateBps / 100).toFixed(1)}% commission
                on marketplace orders only.
              </p>
              <p className="mt-1 text-xs text-ink-faint">
                Orders from your own site never carry a commission.
              </p>
            </div>
            <button
              onClick={() => setListing(!settings.listedOnMarketplace)}
              disabled={busy}
              aria-pressed={settings.listedOnMarketplace}
              className={`mt-1 h-7 w-12 shrink-0 rounded-full p-0.5 transition ${
                settings.listedOnMarketplace ? 'bg-brand' : 'bg-surface-line'
              }`}
            >
              <span
                className={`block h-6 w-6 rounded-full bg-white shadow transition-transform ${
                  settings.listedOnMarketplace ? 'translate-x-5' : ''
                }`}
              />
            </button>
          </div>
        </section>

        <Fieldset title="Store details">
          <Field label="Name" defaultValue={settings.name} onSave={(name) => patch({ name })} />
          <Field label="Tagline" defaultValue={settings.tagline} onSave={(tagline) => patch({ tagline })} />
          <Field label="Phone" defaultValue={settings.phone} onSave={(phone) => patch({ phone })} />
          <Field label="Address" defaultValue={settings.address} onSave={(address) => patch({ address })} />
          <Field
            label="Preparation time (minutes)" type="number" defaultValue={String(settings.prepMinutes)}
            onSave={(v) => patch({ prepMinutes: Number(v) })}
          />
          <Field
            label="Brand colour" type="color" defaultValue={settings.brandColor}
            onSave={(brandColor) => patch({ brandColor })}
          />
        </Fieldset>

        <OpeningHours
          hours={settings.openingHours ?? []}
          autoOpenClose={settings.autoOpenClose}
          busy={busy}
          onSaved={load}
        />

        <DeliveryZones
          zones={settings.deliveryZones}
          busy={busy}
          origin={settings.lat != null && settings.lng != null ? { lat: settings.lat, lng: settings.lng } : null}
          onSave={(deliveryZones) => patchOrThrow({ deliveryZones })}
        />

        {/* Collection from the counter. Off by default because a cloud kitchen has no
            counter to collect from, and turning it on would send customers to a door. */}
        <PlanLock feature={PLAN_FEATURES.PICKUP} entitlements={settings.entitlements}>
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">Pickup</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Let customers collect from your counter. Pickup orders carry no delivery
                fee and are not bound by your zone minimums.
              </p>
            </div>
            <Toggle
              on={settings.pickupEnabled}
              busy={busy}
              onToggle={() => patch({ pickupEnabled: !settings.pickupEnabled } as any)}
            />
          </div>

          {settings.pickupEnabled && (
            <div className="mt-4 max-w-xs">
              <Field
                label="Ready in (minutes)" type="number" defaultValue={String(settings.pickupMinutes)}
                onSave={(v) => patch({ pickupMinutes: Number(v) } as any)}
              />
              <p className="mt-1 text-xs text-ink-faint">
                Shown on your storefront next to the Pickup option. Usually shorter than
                your delivery time — there is no rider leg.
              </p>
            </div>
          )}
        </section>

        </PlanLock>

        <PlanLock feature={PLAN_FEATURES.SCHEDULED_ORDERS} entitlements={settings.entitlements}>
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">Orders for later</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Customers pick a delivery time instead of ordering for now. Iftar, office
                lunch and parties are all booked ahead — and it spreads the kitchen&rsquo;s
                load instead of forty orders landing at once.
              </p>
            </div>
            <Toggle
              on={settings.schedulingEnabled}
              busy={busy}
              onToggle={() => patch({ schedulingEnabled: !settings.schedulingEnabled } as any)}
            />
          </div>

          {settings.schedulingEnabled && (
            <div className="mt-4 max-w-xs">
              <Field
                label="How many days ahead" type="number" defaultValue={String(settings.schedulingMaxDays)}
                onSave={(v) => patch({ schedulingMaxDays: Number(v) } as any)}
              />
              <p className="mt-1 text-xs text-ink-faint">
                How far out a customer may book. Only promise what you can staff.
              </p>
            </div>
          )}
        </section>
        </PlanLock>

        <PlanLock feature={PLAN_FEATURES.ADVANCE_PAYMENT} entitlements={settings.entitlements}>
        <PaymentPolicy
          policy={{
            codEnabled: settings.codEnabled,
            advancePercent: settings.advancePercent,
            advanceThreshold: settings.advanceThreshold,
          }}
          busy={busy}
          gatewayConfigured={settings.canRequireAdvance}
          onSave={patchOrThrow}
        />
        </PlanLock>

        {/* Phase 4: loyalty programme, funded by the vendor. */}
        <PlanLock feature={PLAN_FEATURES.LOYALTY} entitlements={settings.entitlements}>
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">Loyalty programme</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Customers earn points on delivered orders and spend them on future ones.
                You fund the reward, so it comes out of your margin — but repeat customers
                cost nothing to acquire.
              </p>
            </div>
            <Toggle
              on={settings.loyaltyEnabled}
              busy={busy}
              onToggle={() => patch({ loyaltyEnabled: !settings.loyaltyEnabled } as any)}
            />
          </div>

          {settings.loyaltyEnabled && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field
                label="Points per ৳100" type="number" defaultValue={String(settings.pointsPerHundred)}
                onSave={(v) => patch({ pointsPerHundred: Number(v) } as any)}
              />
              <Field
                label="Point value (৳)" type="number" defaultValue={String(settings.pointValue / 100)}
                onSave={(v) => patch({ pointValue: Math.round(Number(v) * 100) } as any)}
              />
              <Field
                label="Minimum to redeem" type="number" defaultValue={String(settings.minRedeemPoints)}
                onSave={(v) => patch({ minRedeemPoints: Number(v) } as any)}
              />
            </div>
          )}
        </section>

        </PlanLock>

        <PlanLock feature={PLAN_FEATURES.AI_ASSISTANT} entitlements={settings.entitlements}>
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">AI ordering assistant</h2>
              <p className="mt-1 text-sm text-ink-muted">
                A chat bubble on your storefront that takes orders in English, Bangla or
                Banglish. It can only ever offer items and prices from your live menu.
              </p>
            </div>
            <Toggle
              on={settings.aiAssistantEnabled}
              busy={busy}
              onToggle={() => patch({ aiAssistantEnabled: !settings.aiAssistantEnabled } as any)}
            />
          </div>

          {settings.aiAssistantEnabled && (
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
                House rules for the assistant
              </span>
              <textarea
                className="field" rows={3} defaultValue={settings.aiPersona}
                placeholder="e.g. Always suggest borhani with kacchi. We don't deliver past 11pm."
                onBlur={(e) => e.target.value !== settings.aiPersona && patch({ aiPersona: e.target.value } as any)}
              />
            </label>
          )}
        </section>

        </PlanLock>

        {/* The vendor's own ad accounts. */}
        <PlanLock feature={PLAN_FEATURES.MARKETING_PIXELS} entitlements={settings.entitlements}>
        <Fieldset title="Advertising pixels">
          <p className="-mt-1 text-sm text-ink-muted">
            Paste the IDs from your own ad accounts. Without them your campaigns cannot
            see which ads produced real orders, and they spend your money on clicks instead.
          </p>
          <Field
            label="Meta (Facebook / Instagram) pixel ID" defaultValue={settings.metaPixelId}
            onSave={(metaPixelId) => patch({ metaPixelId })}
          />
          <Field
            label="TikTok pixel ID" defaultValue={settings.tiktokPixelId}
            onSave={(tiktokPixelId) => patch({ tiktokPixelId })}
          />
          <Field
            label="Google Analytics 4 (G-XXXXXXX)" defaultValue={settings.ga4MeasurementId}
            onSave={(ga4MeasurementId) => patch({ ga4MeasurementId })}
          />
        </Fieldset>
        </PlanLock>

        {/* Customers inviting customers, paid out of the same wallet as loyalty. */}
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="font-bold">Invite a friend</h2>
              <p className="mt-1 text-sm text-ink-muted">
                Both sides get store credit when someone new orders on an invite. Paid on
                delivery of their first order, never on signup — otherwise the codes get
                farmed with throwaway numbers.
              </p>
            </div>
            <Toggle
              on={settings.referralEnabled}
              busy={busy}
              onToggle={() => patch({ referralEnabled: !settings.referralEnabled } as any)}
            />
          </div>

          {settings.referralEnabled && (
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Field
                label="Inviter gets (৳)" type="number" defaultValue={String(settings.referrerReward / 100)}
                onSave={(v) => patch({ referrerReward: Math.round(Number(v) * 100) } as any)}
              />
              <Field
                label="Friend gets (৳)" type="number" defaultValue={String(settings.refereeReward / 100)}
                onSave={(v) => patch({ refereeReward: Math.round(Number(v) * 100) } as any)}
              />
              <Field
                label="Minimum order (৳)" type="number" defaultValue={String(settings.referralMinSpend / 100)}
                onSave={(v) => patch({ referralMinSpend: Math.round(Number(v) * 100) } as any)}
              />
            </div>
          )}
          {settings.referralEnabled && (
            <p className="mt-2 text-xs text-ink-faint">
              Each invite costs you {taka(settings.referrerReward + settings.refereeReward)} in
              credit, so keep the minimum order comfortably above it.
            </p>
          )}
        </section>

        {/*
          Mode A payments: the vendor's OWN gateway. We store these encrypted and never
          read them back — the field below shows only whether something is saved.
        */}
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <h2 className="font-bold">Your payment gateway</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Orders from your own site are paid straight into your merchant account. We never
            hold that money and never take a cut of it.
          </p>
          <p className="mt-2 text-sm">
            {settings.gateway.configured ? (
              <span className="text-emerald-700">
                Connected · {settings.gateway.provider} {settings.gateway.hint}
                {settings.gateway.sandbox && ' (sandbox)'}
              </span>
            ) : (
              <span className="text-ink-muted">
                Not connected — your site accepts cash on delivery only.
              </span>
            )}
          </p>
          <GatewayForm onSaved={load} />
        </section>

        {/* The vendor's own SMS account. Optional — we send from ours until they connect. */}
        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <h2 className="font-bold">Order text messages</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Connect your own SMS account and order texts go out under your name instead of
            ours. Until then we send them for you.
          </p>
          <p className="mt-2 text-sm">
            {settings.sms.configured ? (
              <span className="text-emerald-700">
                Connected{settings.sms.senderId && ` · texts show as “${settings.sms.senderId}”`}
              </span>
            ) : (
              <span className="text-ink-muted">Not connected — we send on your behalf.</span>
            )}
          </p>
          <SmsForm onSaved={load} />
        </section>
      </div>
    </>
  );
}

/** The switch used by the marketplace, loyalty and assistant sections. */
function Toggle({ on, busy, onToggle }: { on: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      disabled={busy}
      aria-pressed={on}
      className={`mt-1 h-7 w-12 shrink-0 rounded-full p-0.5 transition ${on ? 'bg-brand' : 'bg-surface-line'}`}
    >
      <span className={`block h-6 w-6 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

function Fieldset({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
      <h2 className="mb-3 font-bold">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** Save-on-blur: a vendor editing one field shouldn't have to hunt for a Save button. */
function Field({
  label, defaultValue, onSave, type = 'text',
}: {
  label: string; defaultValue: string; onSave: (value: string) => void; type?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  useEffect(() => setValue(defaultValue), [defaultValue]);

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
      <input
        className="field" type={type} value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => value !== defaultValue && onSave(value)}
      />
    </label>
  );
}

/**
 * The vendor's own sms.net.bd account.
 *
 * The sender ID is capped at 11 characters because that is the operator limit for a masked
 * sender in Bangladesh — a longer one is silently rejected at the carrier and the vendor
 * never finds out why their texts stopped looking like theirs.
 */
function SmsForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ provider: 'SMSNETBD', apiKey: '', senderId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-ghost mt-3 h-10 min-h-0 px-3 text-sm">
        Connect an SMS account
      </button>
    );
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi('/vendor/sms', { method: 'POST', body: JSON.stringify(form) });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="mt-3 space-y-3 rounded-xl bg-surface-sunk p-3">
      <select className="field" value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}>
        <option value="SMSNETBD">sms.net.bd</option>
        <option value="NONE">Disconnect</option>
      </select>
      {form.provider !== 'NONE' && (
        <>
          <input className="field" type="password" placeholder="API key" value={form.apiKey}
                 onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <input className="field" maxLength={11} placeholder="Sender name (max 11 characters)"
                 value={form.senderId}
                 onChange={(e) => setForm({ ...form, senderId: e.target.value })} />
          <p className="text-xs text-ink-faint">
            The sender name must already be approved (masked) with your operator. Leave it
            blank to use your account&rsquo;s default.
          </p>
        </>
      )}
      <p className="text-xs text-ink-faint">Stored encrypted. We can never display it back to you.</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-10 min-h-0 flex-1 text-sm">Cancel</button>
        <button className="btn-brand h-10 min-h-0 flex-1 text-sm" disabled={busy}>Save</button>
      </div>
    </form>
  );
}

function GatewayForm({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    provider: 'SSLCOMMERZ',
    storeId: '', storePassword: '',
    appKey: '', appSecret: '', username: '', passwordSecret: '',
    sandbox: true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-ghost mt-3 h-10 min-h-0 px-3 text-sm">
        Connect a gateway
      </button>
    );
  }

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi('/vendor/gateway', { method: 'POST', body: JSON.stringify(form) });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="mt-3 space-y-3 rounded-xl bg-surface-sunk p-3">
      <select className="field" value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value })}>
        <option value="SSLCOMMERZ">SSLCommerz</option>
        <option value="BKASH">bKash</option>
        <option value="NAGAD">Nagad</option>
        <option value="NONE">Disconnect</option>
      </select>
      {form.provider === 'BKASH' && (
        <>
          {/* bKash Tokenized Checkout needs four values, not two — an app key/secret pair
              AND the merchant username/password. Asking for the wrong two is the most
              common reason a vendor's first payment fails. */}
          <input className="field" placeholder="App key" value={form.appKey}
                 onChange={(e) => setForm({ ...form, appKey: e.target.value })} />
          <input className="field" type="password" placeholder="App secret" value={form.appSecret}
                 onChange={(e) => setForm({ ...form, appSecret: e.target.value })} />
          <input className="field" placeholder="Merchant username" value={form.username}
                 onChange={(e) => setForm({ ...form, username: e.target.value })} />
          <input className="field" type="password" placeholder="Merchant password"
                 value={form.passwordSecret}
                 onChange={(e) => setForm({ ...form, passwordSecret: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.sandbox} className="accent-[rgb(var(--brand))]"
                   onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} />
            Sandbox credentials
          </label>
        </>
      )}
      {form.provider !== 'NONE' && form.provider !== 'BKASH' && (
        <>
          <input className="field" placeholder="Store ID / App key" value={form.storeId}
                 onChange={(e) => setForm({ ...form, storeId: e.target.value })} />
          <input className="field" type="password" placeholder="Store password / App secret"
                 value={form.storePassword}
                 onChange={(e) => setForm({ ...form, storePassword: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.sandbox} className="accent-[rgb(var(--brand))]"
                   onChange={(e) => setForm({ ...form, sandbox: e.target.checked })} />
            Sandbox credentials
          </label>
        </>
      )}
      <p className="text-xs text-ink-faint">
        Stored encrypted (AES-256-GCM). We can never display these back to you.
      </p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => setOpen(false)} className="btn-ghost h-10 min-h-0 flex-1 text-sm">Cancel</button>
        <button className="btn-brand h-10 min-h-0 flex-1 text-sm" disabled={busy}>Save</button>
      </div>
    </form>
  );
}
