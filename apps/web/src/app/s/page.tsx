import type { Metadata } from 'next';
import { Suspense } from 'react';
import type { PublicMenu } from '@foodhub/shared';
import { api, currentHost } from '../../lib/api';
import { Dish, MenuSkeleton } from '../../components/Media';
import { CartBar, Menu } from '../../components/Menu';
import { GoesWellWith, ReorderStrip } from '../../components/Suggestions';
import { Assistant } from '../../components/Assistant';
import { StoreHeader } from '../../components/StoreHeader';
import { RestaurantJsonLd } from '../../components/StructuredData';
import { Pixels } from '../../components/Pixels';
import { Reviews } from '../../components/Reviews';
import { Pwa } from '../../components/Pwa';
import { AppShell } from '../../components/AppShell';
import { Toaster } from '../../components/Toast';

/**
 * A vendor's own storefront (Mode A) — their domain, their branding, their gateway.
 *
 * The menu payload is edge-cached for 60s and revalidated in the background, so a
 * repeat visitor gets HTML from cache and never waits on the database.
 */
export const revalidate = 60;

async function getMenu(): Promise<PublicMenu> {
  return api<PublicMenu>('/storefront/menu', { revalidate: 60, tags: ['menu'] });
}

export async function generateMetadata(): Promise<Metadata> {
  try {
    const { tenant } = await getMenu();
    return {
      title: `${tenant.name}${tenant.tagline ? ` — ${tenant.tagline}` : ''}`,
      description: tenant.tagline || `Order from ${tenant.name}.`,
      openGraph: {
        title: tenant.name,
        description: tenant.tagline,
        images: tenant.cover ? [`${tenant.cover.url}-1280.webp`] : undefined,
      },
    };
  } catch {
    return { title: 'Store unavailable' };
  }
}

export default async function StorefrontPage() {
  return (
    <Suspense fallback={<MenuSkeleton />}>
      <Storefront />
    </Suspense>
  );
}

async function Storefront() {
  const host = await currentHost();
  let menu: PublicMenu;
  try {
    menu = await getMenu();
  } catch {
    return (
      <AppShell className="grid place-items-center px-6 text-center">
        <div>
          <h1 className="text-xl font-bold">This store isn’t available</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Nothing is set up at <span className="font-medium">{host}</span> yet.
          </p>
        </div>
      </AppShell>
    );
  }

  const { tenant, categories, offers, reviews, combos } = menu;

  return (
    <AppShell
      className="pb-28"
      // Each vendor's brand colour drives the whole storefront through one variable.
      style={{ ['--brand' as string]: hexToRgb(tenant.brandColor) }}
    >
      {/* Structured data + the vendor's own pixels. Both are pure additions to the head
          and neither blocks the menu rendering. */}
      <RestaurantJsonLd tenant={tenant} categories={categories} combos={combos} url={`https://${host}`} />
      <Pixels tenant={tenant} />

      <StoreHeader tenant={tenant} offers={offers} />

      <div className="px-3">
        {!tenant.isOpen && (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-[13px] font-semibold text-amber-800">
            The kitchen is closed right now. You can still browse the menu.
          </p>
        )}
        <ReorderStrip tenant={tenant} />
        <Menu tenant={tenant} categories={categories} combos={combos} />
        <GoesWellWith tenant={tenant} />
        <Reviews tenant={tenant} reviews={reviews ?? []} />
      </div>

      <CartBar tenant={tenant} />
      <Assistant brandName={tenant.name} />
      <Toaster />
      <Pwa />
    </AppShell>
  );
}

/** "#E8533F" -> "232 83 63", the form Tailwind's <alpha-value> syntax expects. */
function hexToRgb(hex: string): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex ?? '');
  if (!m) return '232 83 63';
  return `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`;
}
