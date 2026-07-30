import type { ComboDto, PublicCategory, PublicTenant } from '@foodhub/shared';

/**
 * Schema.org markup for a restaurant page.
 *
 * This is what turns a Google result from a blue link into a card with the name, the price
 * range, the opening state and a row of stars. It is worth doing now specifically because
 * the ratings underneath it are real — `AggregateRating` on invented numbers is both a
 * lie and a manual action waiting to happen, so the block is omitted entirely for a store
 * nobody has rated.
 */
export function RestaurantJsonLd({
  tenant,
  categories,
  combos = [],
  url,
}: {
  tenant: PublicTenant;
  categories: PublicCategory[];
  combos?: ComboDto[];
  url: string;
}) {
  const products = categories.flatMap((c) => c.products);
  const prices = products.map((p) => p.price).filter((p) => p > 0);

  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: tenant.name,
    description: tenant.tagline || `Order from ${tenant.name}.`,
    url,
    servesCuisine: 'Bangladeshi',
    // Google reads currency from the price range string, so the symbol matters.
    priceRange: prices.length
      ? `৳${Math.round(Math.min(...prices) / 100)}–৳${Math.round(Math.max(...prices) / 100)}`
      : undefined,
    image: tenant.cover ? [`${absolute(url)}${tenant.cover.url}-1280.webp`] : undefined,
    telephone: tenant.phone || undefined,
    address: tenant.address
      ? { '@type': 'PostalAddress', streetAddress: tenant.address, addressCountry: 'BD' }
      : undefined,
    geo:
      tenant.lat != null && tenant.lng != null
        ? { '@type': 'GeoCoordinates', latitude: tenant.lat, longitude: tenant.lng }
        : undefined,
    acceptsReservations: false,
    hasMenu: {
      '@type': 'Menu',
      hasMenuSection: [
        ...categories.map((category) => ({
          '@type': 'MenuSection',
          name: category.name,
          hasMenuItem: category.products.map((product) => ({
            '@type': 'MenuItem',
            name: product.name,
            description: product.description || undefined,
            offers: {
              '@type': 'Offer',
              price: (product.price / 100).toFixed(2),
              priceCurrency: 'BDT',
              availability: product.isAvailable
                ? 'https://schema.org/InStock'
                : 'https://schema.org/OutOfStock',
            },
          })),
        })),
        ...(combos.length
          ? [{
              '@type': 'MenuSection',
              name: 'Meal deals',
              hasMenuItem: combos.map((combo) => ({
                '@type': 'MenuItem',
                name: combo.name,
                description: combo.description || undefined,
                offers: {
                  '@type': 'Offer',
                  price: (combo.price / 100).toFixed(2),
                  priceCurrency: 'BDT',
                },
              })),
            }]
          : []),
      ],
    },
  };

  // Only claim a rating that exists. Omitted, not zeroed — a 0-star restaurant reads far
  // worse than an unrated one, and inventing the number is grounds for a manual penalty.
  if (tenant.rating != null && tenant.ratingCount > 0) {
    data.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: tenant.rating.toFixed(1),
      reviewCount: tenant.ratingCount,
      bestRating: 5,
      worstRating: 1,
    };
  }

  return (
    <script
      type="application/ld+json"
      // Server-rendered constant, and JSON.stringify escapes the values — the only
      // remaining risk is a literal </script> inside a dish name, hence the replace.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(prune(data)).replace(/</g, '\\u003c') }}
    />
  );
}

/** Undefined keys would serialise as missing anyway; nested ones would not. */
function prune<T>(value: T): T {
  if (Array.isArray(value)) return value.map(prune) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => [k, prune(v)]),
    ) as T;
  }
  return value;
}

function absolute(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}
