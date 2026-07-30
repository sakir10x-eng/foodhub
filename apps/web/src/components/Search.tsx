'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { formatBDT } from '@foodhub/shared';
import { clientApi } from '../lib/client';
import { Skeleton } from './Media';

interface Results {
  dishes: {
    id: string;
    name: string;
    price: number;
    isAvailable: boolean;
    vendorSlug: string;
    vendorName: string;
    vendorOpen: boolean;
    image: { url: string; blurhash: string | null } | null;
  }[];
  vendors: { id: string; slug: string; name: string; tagline: string; isOpen: boolean }[];
}

/**
 * Instant search. Typing is debounced to 180ms — long enough that a fast typist fires
 * one request instead of eight, short enough to still feel like it is keeping up.
 */
export function SearchBar() {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      // Cancel the previous request so a slow early keystroke can't overwrite a fast
      // later one — otherwise results flicker back to a stale term.
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      try {
        const data = await clientApi<Results>(`/marketplace/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        setResults(data);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setResults({ dishes: [], vendors: [] });
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);

    return () => clearTimeout(timer);
  }, [term]);

  const empty = results && results.dishes.length === 0 && results.vendors.length === 0;

  return (
    <div className="relative">
      <div className="relative">
        <svg
          className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-ink-faint"
          width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search biryani, pizza, chai…"
          aria-label="Search dishes and restaurants"
          className="field pl-11"
          enterKeyHint="search"
        />
      </div>

      {term.trim().length >= 2 && (
        <div className="card absolute inset-x-0 top-full z-30 mt-2 max-h-[65vh] overflow-y-auto p-2">
          {loading && !results && (
            <div className="space-y-2 p-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="h-11 w-11 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-1/2" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {empty && <p className="p-4 text-center text-sm text-ink-muted">Nothing matched “{term}”.</p>}

          {results && results.vendors.length > 0 && (
            <section>
              <h3 className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Restaurants
              </h3>
              <ul>
                {results.vendors.map((v) => (
                  <li key={v.id}>
                    <Link
                      href={`/m/r/${v.slug}`}
                      prefetch
                      className="flex items-center justify-between rounded-lg px-2 py-2.5 hover:bg-surface-sunk"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold">{v.name}</span>
                        {v.tagline && <span className="block truncate text-xs text-ink-muted">{v.tagline}</span>}
                      </span>
                      {!v.isOpen && <span className="ml-2 shrink-0 text-xs text-ink-faint">Closed</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {results && results.dishes.length > 0 && (
            <section>
              <h3 className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Dishes
              </h3>
              <ul>
                {results.dishes.map((d) => (
                  <li key={d.id}>
                    <Link
                      href={`/m/r/${d.vendorSlug}`}
                      prefetch
                      className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-sunk"
                    >
                      <span
                        className="h-11 w-11 shrink-0 rounded-lg bg-surface-sunk bg-cover bg-center"
                        style={
                          d.image
                            ? { backgroundImage: `url(${d.image.url}-160.webp)` }
                            : undefined
                        }
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{d.name}</span>
                        <span className="block truncate text-xs text-ink-muted">{d.vendorName}</span>
                      </span>
                      <span className="shrink-0 text-sm font-bold tabular-nums">{formatBDT(d.price)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
