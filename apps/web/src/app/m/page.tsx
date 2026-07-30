import { Suspense } from 'react';
import type { Metadata } from 'next';
import type { Paginated, PublicTenant } from '@foodhub/shared';
import { api } from '../../lib/api';
import { VendorListSkeleton } from '../../components/Media';
import { VendorFeed } from '../../components/VendorFeed';
import { LanguageToggle } from '../../components/LanguageToggle';
import { SearchBar } from '../../components/Search';
import { T } from '../../lib/i18n';
import Link from 'next/link';
import { Icon } from '../../components/Icon';

export const metadata: Metadata = {
  title: 'FoodHub — order from restaurants near you',
  description: 'Browse restaurants, search dishes and order in a few taps.',
};

/** The mother marketplace home. Edge-cached; it is the same for everyone. */
export const revalidate = 60;

export default function MarketplaceHome() {
  return (
    <main className="mx-auto max-w-5xl pb-16">
      <header className="px-4 pb-2 pt-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight">
              <T k="home.title" />
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              <T k="home.subtitle" />
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <LanguageToggle />
            {/* Vendor acquisition lives one tap from the busiest page we have. */}
            <Link
              href="/for-restaurants"
              className="hidden shrink-0 items-center gap-1.5 rounded-full border border-surface-line px-3 py-2 text-xs font-semibold text-ink-muted transition hover:border-brand hover:text-brand sm:inline-flex"
            >
              <Icon name="store" size={14} />
              রেস্টুরেন্টের জন্য
            </Link>
          </div>
        </div>
        <div className="mt-4">
          <SearchBar />
        </div>
      </header>

      <Suspense fallback={<VendorListSkeleton />}>
        <VendorGrid />
      </Suspense>
    </main>
  );
}

async function VendorGrid() {
  /*
   * Both fetches are edge-cached and neither depends on the other, so they go together —
   * the chips must not wait for the vendor list to come back before they can render.
   */
  const [vendors, facets] = await Promise.all([
    api<Paginated<PublicTenant>>('/marketplace/vendors?pageSize=24', {
      revalidate: 60,
      tags: ['marketplace'],
    }),
    api<{ tag: string; count: number }[]>('/marketplace/cuisines', {
      revalidate: 300,
      tags: ['marketplace'],
    }).catch(() => [] as { tag: string; count: number }[]),
  ]);

  if (vendors.data.length === 0) {
    return (
      <p className="px-4 py-16 text-center text-sm text-ink-muted">
        <T k="home.empty" />
      </p>
    );
  }

  return <VendorFeed initial={vendors} facets={facets} />;
}
