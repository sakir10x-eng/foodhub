import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import type { PublicMenu } from '@foodhub/shared';
import { api, ApiError } from '../../../../lib/api';
import { StoreHeader } from '../../../../components/StoreHeader';
import { RestaurantJsonLd } from '../../../../components/StructuredData';
import { Reviews } from '../../../../components/Reviews';
import { CartBar, Menu } from '../../../../components/Menu';
import { GoesWellWith } from '../../../../components/Suggestions';
import { Pwa } from '../../../../components/Pwa';
import { AppShell } from '../../../../components/AppShell';
import { Toaster } from '../../../../components/Toast';

/**
 * One vendor's page inside the marketplace (Mode B).
 *
 * Same catalog, same components as the vendor's own storefront — the only difference is
 * that checkout from here runs on OUR gateway and takes a commission.
 */
export const revalidate = 60;

async function getMenu(slug: string): Promise<PublicMenu> {
  return api<PublicMenu>(`/marketplace/vendors/${encodeURIComponent(slug)}`, {
    revalidate: 60,
    tags: [`vendor:${slug}`],
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  try {
    const { tenant } = await getMenu(slug);
    return {
      title: `${tenant.name} — order on FoodHub`,
      description: tenant.tagline || `Order from ${tenant.name} on FoodHub.`,
    };
  } catch {
    return { title: 'Restaurant not found' };
  }
}

export default async function VendorPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  let menu: PublicMenu;
  try {
    menu = await getMenu(slug);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const { tenant, categories, offers, reviews, combos } = menu;

  return (
    <AppShell
      className="pb-28"
      // The vendor's brand colour follows them onto the marketplace: they are the same
      // business here as on their own site, not a white-labelled row in our directory.
      style={{ ['--brand' as string]: hexToRgb(tenant.brandColor) }}
    >
      <RestaurantJsonLd
        tenant={tenant}
        categories={categories}
        combos={combos}
        url={`https://${process.env.NEXT_PUBLIC_PLATFORM_DOMAIN ?? 'foodhub'}/m/r/${slug}`}
      />

      <StoreHeader tenant={tenant} offers={offers} backHref="/m" />

      <div className="px-3">
        <Menu tenant={tenant} categories={categories} combos={combos} />
        <GoesWellWith tenant={tenant} />
        <Reviews tenant={tenant} reviews={reviews ?? []} />
      </div>

      <CartBar tenant={tenant} />
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
