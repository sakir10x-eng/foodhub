'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AuthResponse } from '@foodhub/shared';
import { API_BASE, useAuth } from '../../lib/auth';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const search = useSearchParams();
  const setSession = useAuth((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Arriving from the signup form on the marketing site: prefill so they only type
  // the password they just chose.
  useEffect(() => {
    const prefill = search.get('email');
    if (prefill) setEmail(prefill);
  }, [search]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.message ?? 'Sign in failed');

      const session = body as AuthResponse;
      if (session.user.role === 'CUSTOMER') {
        throw new Error('This panel is for restaurant accounts.');
      }
      setSession(session);
      // A platform admin has no tenant, so every vendor screen would 403 against them.
      router.replace(session.user.role === 'PLATFORM_ADMIN' ? '/platform' : '/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-extrabold tracking-tight">FoodHub for restaurants</h1>
        <p className="mt-1 text-sm text-ink-muted">Sign in to manage your menu and orders.</p>

        <form onSubmit={submit} className="mt-6 space-y-3">
          <input
            className="field" type="email" required autoComplete="username"
            placeholder="you@restaurant.com" value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            className="field" type="password" required autoComplete="current-password"
            placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button className="btn-brand w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}

        <div className="mt-8 space-y-2 rounded-xl bg-surface-sunk p-3 text-xs leading-relaxed text-ink-muted">
          <p>
            <strong className="text-ink">Vendor:</strong> <code>kacchi-bhai@foodhub.test</code>,{' '}
            <code>pizza-shack@foodhub.test</code>, <code>chai-adda@foodhub.test</code>
          </p>
          <p>
            <strong className="text-ink">Superadmin:</strong> <code>admin@foodhub.test</code> — opens the
            platform console instead of a vendor panel.
          </p>
          <p>Password for all: <code>password123</code></p>
        </div>
      </div>
    </main>
  );
}
