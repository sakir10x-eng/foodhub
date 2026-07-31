import { NextRequest, NextResponse } from 'next/server';

/**
 * Host -> channel routing, the front door of the whole product.
 *
 *   lvh.me            -> the mother marketplace   (rewrites / to /m)
 *   <slug>.lvh.me     -> that vendor's storefront (rewrites / to /s)
 *   kacchi-bhai.test  -> ditto, via a custom domain
 *
 * The API does the authoritative Host -> tenant resolution; this only decides which
 * set of pages to render, so an unknown host still reaches the storefront route and
 * gets a proper 404 from the API rather than a rewrite loop.
 */
const MARKETPLACE_HOST = (process.env.NEXT_PUBLIC_MARKETPLACE_HOST ?? 'lvh.me:3000').split(':')[0];

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  const isMarketplace = host === MARKETPLACE_HOST || host === `www.${MARKETPLACE_HOST}`;
  const { pathname } = req.nextUrl;

  // Shared routes (checkout, order tracking, the rider run sheet, mock pay) render the
  // same on both channels. A new top-level page MUST be listed here: on the marketplace
  // host the branch below rewrites anything unlisted to /m/<path>, which 404s.
  const shared = ['/checkout', '/order', '/pay', '/rider', '/_next', '/favicon', '/api'];
  if (shared.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const url = req.nextUrl.clone();

  if (isMarketplace) {
    // Marketplace pages already live under /m; only the bare root needs rewriting.
    if (pathname === '/') url.pathname = '/m';
    else if (!pathname.startsWith('/m')) url.pathname = `/m${pathname}`;
    else return NextResponse.next();
  } else {
    if (pathname === '/') url.pathname = '/s';
    else return NextResponse.next();
  }

  const res = NextResponse.rewrite(url);
  res.headers.set('x-foodhub-channel', isMarketplace ? 'marketplace' : 'storefront');
  return res;
}

export const config = {
  // Skip anything with a file extension. Without this the marketplace branch below
  // rewrites /sw.js and /icon-192.png into /m/sw.js and /m/icon-192.png, and every
  // static file in public/ 404s on the marketplace host. None of our routes contain a
  // dot, so matching on one is a safe way to mean "static asset".
  matcher: ['/((?!_next/static|_next/image|favicon.ico|media|.*\\..*).*)'],
};
