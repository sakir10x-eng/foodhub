import type { MetadataRoute } from 'next';
import { api, currentHost } from '../lib/api';
import type { PublicMenu } from '@foodhub/shared';

/**
 * Per-host sitemap.
 *
 * Every vendor storefront is its own site on its own domain, so each one gets a sitemap
 * describing only itself — a shared sitemap listing other restaurants' pages would be
 * pointing Google at a domain that does not serve them.
 *
 * `revalidate` is deliberately long: a sitemap is polled by crawlers, not read by people,
 * and regenerating it per request would put a menu query behind every bot visit.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const host = await currentHost();
  const base = `https://${host.split(':')[0]}`;

  const entries: MetadataRoute.Sitemap = [
    { url: base, changeFrequency: 'daily', priority: 1 },
  ];

  try {
    const menu = await api<PublicMenu>('/storefront/menu', { revalidate: 3600, tags: ['menu'] });
    // Category anchors rather than product URLs: menu items have no page of their own, and
    // listing URLs that 404 is worse for a domain than listing nothing.
    for (const category of menu.categories) {
      entries.push({
        url: `${base}/#${category.id}`,
        changeFrequency: 'weekly',
        priority: 0.7,
      });
    }
  } catch {
    // An unresolvable host still deserves a valid sitemap with its home page in it.
  }

  return entries;
}
