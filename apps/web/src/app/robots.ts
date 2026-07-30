import type { MetadataRoute } from 'next';
import { currentHost } from '../lib/api';

/**
 * Crawl rules, per host.
 *
 * `/checkout` and `/order/*` are disallowed on purpose: an order tracking URL carries a
 * phone number in its query string, and a crawled one would sit in a search index. They
 * are also worthless as search results — nobody is looking for someone else's receipt.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const host = (await currentHost()).split(':')[0];
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/checkout', '/order/', '/pay/', '/api/'],
    },
    sitemap: `https://${host}/sitemap.xml`,
  };
}
