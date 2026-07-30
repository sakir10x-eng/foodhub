import { Suspense } from 'react';
import type { Metadata } from 'next';
import type { Paginated, PublicTenant } from '@foodhub/shared';
import { api } from '../../lib/api';
import { VendorListSkeleton } from '../../components/Media';
import { VendorCard } from '../../components/VendorCard';
import { SearchBar } from '../../components/Search';
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
              What are you eating today?
            </h1>
            <p className="mt-1 text-sm text-ink-muted">Restaurants delivering in Dhaka</p>
          </div>
          {/* Vendor acquisition lives one tap from the busiest page we have. */}
          <Link
            href="/for-restaurants"
            className="hidden shrink-0 items-center gap-1.5 rounded-full border border-surface-line px-3 py-2 text-xs font-semibold text-ink-muted transition hover:border-brand hover:text-brand sm:inline-flex"
          >
            <Icon name="store" size={14} />
            রেস্টুরেন্টের জন্য
          </Link>
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
  const vendors = await api<Paginated<PublicTenant>>('/marketplace/vendors?pageSize=24', {
    revalidate: 60,
    tags: ['marketplace'],
  });

  if (vendors.data.length === 0) {
    return (
      <p className="px-4 py-16 text-center text-sm text-ink-muted">
        No restaurants are listed yet. Check back shortly.
      </p>
    );
  }

  return (
    <>
      <h2 className="px-4 pt-4 text-[15px] font-bold">
        {vendors.total} restaurant{vendors.total === 1 ? '' : 's'}
      </h2>
      <ul className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-3">
        {vendors.data.map((vendor, i) => (
          <li key={vendor.id}>
            <VendorCard vendor={vendor} priority={i < 3} />
          </li>
        ))}
      </ul>
    </>
  );
}
