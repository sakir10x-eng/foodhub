'use client';

import { useState } from 'react';
import { clientApi, ApiError } from '../../lib/client';
import { Icon } from '../Icon';

/**
 * Real vendor onboarding, not a brochure form.
 *
 * Posts to the same `/auth/register/vendor` endpoint the product uses, which creates the
 * tenant, its owner, a FREE subscription and a starter category in one transaction. On
 * success the restaurant already exists and its storefront is live — we hand them
 * straight to the panel rather than promising a follow-up email.
 */
export function VendorSignup({ adminUrl, storefrontSuffix }: { adminUrl: string; storefrontSuffix: string }) {
  const [form, setForm] = useState({
    businessName: '',
    slug: '',
    ownerName: '',
    email: '',
    phone: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ slug: string } | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);

  /** Suggest the address from the business name until the owner edits it themselves. */
  const onName = (businessName: string) => {
    setForm((f) => ({
      ...f,
      businessName,
      slug: slugTouched ? f.slug : slugify(businessName),
    }));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await clientApi('/auth/register/vendor', { method: 'POST', body: JSON.stringify(form) });
      setDone({ slug: form.slug });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'কিছু একটা সমস্যা হয়েছে, আবার চেষ্টা করুন।');
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-500 text-white">
          <Icon name="check" size={24} strokeWidth={2.4} />
        </span>
        <h3 className="mt-3 text-lg font-extrabold">দোকান তৈরি হয়ে গেছে!</h3>
        <p className="mt-1 text-sm text-emerald-900">
          আপনার সাইট এখনই লাইভ:{' '}
          <a
            href={`https://${done.slug}${storefrontSuffix}`}
            className="font-bold underline"
            target="_blank"
            rel="noreferrer"
          >
            {done.slug}
            {storefrontSuffix}
          </a>
        </p>
        <p className="mt-2 text-xs text-emerald-900/80">
          এখন প্যানেলে ঢুকে মেনু যোগ করুন — প্রথম অর্ডার নিতে আর কিছু লাগবে না।
        </p>
        {/* The panel is a different origin, so the session cannot be handed over —
            the email is prefilled instead of pretending they are already signed in. */}
        <a
          href={`${adminUrl}/login?email=${encodeURIComponent(form.email)}`}
          className="btn-brand mt-4 w-full"
        >
          প্যানেলে যান
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="রেস্টুরেন্টের নাম" value={form.businessName} onChange={onName} placeholder="যেমন: কাচ্চি ভাই" required />

      <label className="block">
        <span className="mb-1 block text-xs font-semibold text-ink-muted">আপনার সাইটের ঠিকানা</span>
        <span className="flex items-center rounded-xl border border-surface-line bg-white focus-within:border-brand focus-within:ring-4 focus-within:ring-brand/10">
          <input
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true);
              setForm({ ...form, slug: slugify(e.target.value) });
            }}
            placeholder="kacchi-bhai"
            required
            minLength={3}
            className="w-0 flex-1 bg-transparent px-4 py-3 text-[15px] outline-none"
          />
          <span className="shrink-0 truncate px-3 text-xs text-ink-faint">{storefrontSuffix}</span>
        </span>
      </label>

      <Field label="আপনার নাম" value={form.ownerName} onChange={(v) => setForm({ ...form, ownerName: v })} required />
      <Field label="ইমেইল" type="email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} required />
      <Field label="মোবাইল" type="tel" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} placeholder="01XXXXXXXXX" required />
      <Field label="পাসওয়ার্ড" type="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder="কমপক্ষে ৮ অক্ষর" required />

      {error && (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      )}

      <button className="btn-brand w-full" disabled={busy}>
        {busy ? 'তৈরি হচ্ছে…' : 'ফ্রি দোকান খুলুন'}
      </button>
      <p className="text-center text-xs text-ink-faint">
        কোনো কার্ড লাগবে না। Free প্ল্যানে চিরকাল বিনামূল্যে।
      </p>
    </form>
  );
}

function Field({
  label, value, onChange, type = 'text', placeholder, required,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-ink-muted">{label}</span>
      <input
        className="field"
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Mirrors the server's `slug` rule so the field can't produce something it will reject. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40);
}
