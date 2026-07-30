'use client';

import { useCallback, useEffect, useState } from 'react';
import type { DomainDto } from '@foodhub/shared';
import { adminApi, useAuth } from '../../lib/auth';
import { Banner, PageHeader, Shell } from '../../components/Shell';

export default function DomainsPage() {
  return (
    <Shell>
      <Domains />
    </Shell>
  );
}

/**
 * Custom-domain connect flow.
 *
 * The vendor points a CNAME at our edge; Caddy provisions the certificate on the first
 * request via its on-demand TLS `ask` hook, which checks this table. Nothing here needs
 * a support ticket or a deploy.
 */
function Domains() {
  const [domains, setDomains] = useState<DomainDto[] | null>(null);
  const [hostname, setHostname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const slug = useAuth((s) => s.user?.tenantSlug);

  const platformDomain = (process.env.NEXT_PUBLIC_PLATFORM_DOMAIN ?? 'lvh.me:3000');

  const load = useCallback(async () => {
    try {
      setDomains(await adminApi<DomainDto[]>('/vendor/domains'));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await adminApi('/vendor/domains', { method: 'POST', body: JSON.stringify({ hostname: hostname.trim() }) });
      setHostname('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (domain: DomainDto) => {
    if (!window.confirm(`Disconnect ${domain.hostname}?`)) return;
    try {
      await adminApi(`/vendor/domains/${domain.id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <PageHeader title="Domain" />

      <div className="max-w-2xl space-y-6 p-4">
        {error && <Banner tone="error">{error}</Banner>}

        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <h2 className="font-bold">Your FoodHub address</h2>
          <p className="mt-1 break-all text-sm text-ink-muted">
            https://{slug}.{platformDomain}
          </p>
          <p className="mt-1 text-xs text-ink-faint">Always available, no setup needed.</p>
        </section>

        <section className="rounded-2xl border border-surface-line bg-white p-4 shadow-card">
          <h2 className="font-bold">Your own domain</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Point a CNAME record at the address below, then add the domain here. The HTTPS
            certificate is issued automatically the first time someone visits.
          </p>

          <div className="mt-3 rounded-xl bg-surface-sunk p-3 font-mono text-xs">
            <div className="flex justify-between gap-3">
              <span className="text-ink-faint">Type</span><span>CNAME</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-ink-faint">Name</span><span>www (or @)</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-ink-faint">Value</span>
              <span className="break-all">{domains?.[0]?.cnameTarget ?? 'edge.foodhub.com.bd'}</span>
            </div>
          </div>

          <form onSubmit={add} className="mt-3 flex gap-2">
            <input
              className="field" placeholder="order.myrestaurant.com.bd" value={hostname}
              onChange={(e) => setHostname(e.target.value)} required
            />
            <button className="btn-brand shrink-0 px-4" disabled={busy}>Add</button>
          </form>

          {domains === null ? (
            <div className="skeleton mt-4 h-12 w-full rounded-xl" />
          ) : domains.length === 0 ? (
            <p className="mt-4 text-sm text-ink-faint">No custom domain connected yet.</p>
          ) : (
            <ul className="mt-4 divide-y divide-surface-line">
              {domains.map((domain) => (
                <li key={domain.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{domain.hostname}</span>
                    <span className="block text-xs text-ink-faint">
                      {domain.verifiedAt
                        ? `Live · certificate ${domain.sslStatus.toLowerCase()}`
                        : 'Waiting for the first request — check your DNS has propagated'}
                      {domain.isPrimary && ' · primary'}
                    </span>
                  </span>
                  <button onClick={() => remove(domain)} className="shrink-0 text-sm font-semibold text-red-700">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
