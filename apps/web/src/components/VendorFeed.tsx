'use client';

import { useEffect, useMemo, useState } from 'react';
import { VENDOR_SORTS, cuisineLabel, type Paginated, type PublicTenant, type VendorSort } from '@foodhub/shared';
import { clientApi } from '../lib/client';
import { useI18n, plural } from '../lib/i18n';
import { VendorCard } from './VendorCard';
import { VendorListSkeleton } from './Media';
import { Icon } from './Icon';

interface Facet {
  tag: string;
  count: number;
}

interface Filters {
  cuisine: string | null;
  openNow: boolean;
  freeDelivery: boolean;
  sort: VendorSort;
}

const NO_FILTERS: Filters = { cuisine: null, openNow: false, freeDelivery: false, sort: 'relevance' };

function isDefault(f: Filters): boolean {
  return !f.cuisine && !f.openNow && !f.freeDelivery && f.sort === 'relevance';
}

/**
 * The marketplace feed and its filters.
 *
 * The unfiltered feed is rendered on the server and handed in as `initial`, so the page
 * still arrives complete for a crawler and for the first paint. Only when a filter is
 * touched does this component start fetching — which keeps the edge cache doing its job
 * for the request everybody makes, and spends a round trip only on the ones they don't.
 */
export function VendorFeed({
  initial,
  facets,
}: {
  initial: Paginated<PublicTenant>;
  facets: Facet[];
}) {
  const { t, locale } = useI18n();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [result, setResult] = useState<Paginated<PublicTenant>>(initial);
  const [loading, setLoading] = useState(false);

  // The server-rendered list is the answer to the unfiltered question; if the page is
  // revalidated underneath us, take the fresh copy rather than a stale one in state.
  useEffect(() => {
    if (isDefault(filters)) setResult(initial);
  }, [initial, filters]);

  const query = useMemo(() => {
    const params = new URLSearchParams({ pageSize: '24' });
    if (filters.cuisine) params.set('cuisine', filters.cuisine);
    if (filters.openNow) params.set('openNow', '1');
    if (filters.freeDelivery) params.set('freeDelivery', '1');
    if (filters.sort !== 'relevance') params.set('sort', filters.sort);
    return params.toString();
  }, [filters]);

  useEffect(() => {
    if (isDefault(filters)) return;
    let cancelled = false;
    setLoading(true);
    clientApi<Paginated<PublicTenant>>(`/marketplace/vendors?${query}`)
      .then((data) => {
        if (!cancelled) setResult(data);
      })
      .catch(() => {
        // A failed filter should not blank the page — keep showing what is on screen.
        if (!cancelled) setResult((prev) => prev);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, filters]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <>
      {/* Cuisine chips. Full-bleed on a phone via .rail — see globals.css; a hand-rolled
          negative margin overhangs the column. */}
      {facets.length > 0 && (
        <div className="rail mt-3 flex gap-2 px-4 pb-1">
          <Chip active={!filters.cuisine} onClick={() => set({ cuisine: null })}>
            {t('filter.all')}
          </Chip>
          {facets.map((f) => (
            <Chip
              key={f.tag}
              active={filters.cuisine === f.tag}
              onClick={() => set({ cuisine: filters.cuisine === f.tag ? null : f.tag })}
            >
              {cuisineLabel(f.tag, locale)}
            </Chip>
          ))}
        </div>
      )}

      <div className="rail flex items-center gap-2 px-4 py-2">
        <Chip active={filters.openNow} onClick={() => set({ openNow: !filters.openNow })}>
          {t('filter.openNow')}
        </Chip>
        <Chip active={filters.freeDelivery} onClick={() => set({ freeDelivery: !filters.freeDelivery })}>
          {t('filter.freeDelivery')}
        </Chip>
        <label className="relative ml-auto shrink-0">
          <span className="sr-only">{t('filter.sort')}</span>
          <select
            value={filters.sort}
            onChange={(e) => set({ sort: e.target.value as VendorSort })}
            className={`appearance-none rounded-full border px-3 py-1.5 pr-7 text-[13px] font-semibold transition ${
              filters.sort === 'relevance'
                ? 'border-surface-line bg-surface-edge text-ink-muted'
                : 'border-brand bg-brand text-white'
            }`}
          >
            {VENDOR_SORTS.filter((s) => s !== 'distance').map((s) => (
              <option key={s} value={s} className="text-ink">
                {t(`filter.sort.${s}` as 'filter.sort.relevance')}
              </option>
            ))}
          </select>
          {/* The icon set has one chevron, pointing right; a select wants it pointing down. */}
          <Icon
            name="chevron"
            size={13}
            className={`pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rotate-90 ${
              filters.sort === 'relevance' ? 'text-ink-muted' : 'text-white'
            }`}
          />
        </label>
      </div>

      {loading ? (
        <VendorListSkeleton />
      ) : result.data.length === 0 ? (
        <div className="px-4 py-16 text-center">
          <p className="text-sm text-ink-muted">{t('home.noMatch')}</p>
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="mt-3 rounded-full border border-surface-line px-4 py-2 text-sm font-semibold text-brand"
          >
            {t('home.clearFilters')}
          </button>
        </div>
      ) : (
        <>
          <h2 className="px-4 pt-2 text-[15px] font-bold">{plural(t, 'home.count', result.total)}</h2>
          <ul className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.data.map((vendor, i) => (
              <li key={vendor.id}>
                <VendorCard vendor={vendor} priority={i < 3} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition ${
        active
          ? 'border-brand bg-brand text-white'
          : 'border-surface-line bg-surface-edge text-ink-muted hover:border-brand hover:text-brand'
      }`}
    >
      {children}
    </button>
  );
}
