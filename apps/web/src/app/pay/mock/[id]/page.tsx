'use client';

import { use, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { clientApi } from '../../../../lib/client';

/**
 * Stand-in for the gateway's hosted payment page, used only when no live gateway
 * credentials are configured. It lets the whole flow — order, IPN, settlement — be
 * walked end to end in development. The API refuses to issue a mock session in
 * production, so this page is unreachable there.
 */
export default function MockPayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const search = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const code = search.get('order') ?? '';
  const phone = search.get('phone') ?? '';

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await clientApi(`/payments/mock/${id}/confirm`, { method: 'POST' });
      router.push(`/order/${code}?phone=${encodeURIComponent(phone)}`);
    } catch {
      setError('Could not confirm the payment.');
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-dvh max-w-sm place-items-center px-6">
      <div className="w-full text-center">
        <p className="mb-2 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-bold uppercase tracking-wide text-amber-800">
          Sandbox
        </p>
        <h1 className="text-xl font-bold">Mock payment gateway</h1>
        <p className="mt-2 text-sm text-ink-muted">
          No live gateway credentials are configured, so this page stands in for the
          hosted checkout. Confirming marks the payment received exactly as a real IPN would.
        </p>
        <div className="mt-6 space-y-2">
          <button onClick={confirm} disabled={busy} className="btn-brand w-full">
            {busy ? 'Confirming…' : 'Simulate successful payment'}
          </button>
          <button onClick={() => router.push(`/order/${code}?phone=${encodeURIComponent(phone)}`)}
                  className="btn-ghost w-full">
            Cancel and view order
          </button>
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      </div>
    </main>
  );
}
