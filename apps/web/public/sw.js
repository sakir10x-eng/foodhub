/**
 * FoodHub service worker.
 *
 * Written by hand rather than generated, because the caching rules here are
 * business decisions, not boilerplate:
 *
 *   - the app shell is precached, so a cold start on a weak connection paints instantly;
 *   - menus are stale-while-revalidate — a customer on 2G sees last night's menu in
 *     milliseconds while the fresh one loads behind it;
 *   - anything involving money or an order is NEVER cached. A stale cart total or a
 *     cached "PREPARING" on an order that was delivered is worse than a spinner.
 */
const VERSION = 'v1';
const SHELL_CACHE = `foodhub-shell-${VERSION}`;
const MENU_CACHE = `foodhub-menu-${VERSION}`;
const IMAGE_CACHE = `foodhub-img-${VERSION}`;

const SHELL_ASSETS = ['/', '/offline'];

/** Requests that must always hit the network, even offline (they fail loudly instead). */
const NEVER_CACHE = [
  '/api/storefront/checkout',
  '/api/marketplace/checkout',
  '/api/orders/track',
  '/api/payments/',
  '/api/auth/',
  '/api/storefront/loyalty',
  '/api/storefront/assistant',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_ASSETS).catch(() => undefined))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('foodhub-') && !k.endsWith(VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (NEVER_CACHE.some((p) => url.pathname.startsWith(p))) return;

  // Image ladder is content-addressed by upload id — cache-first, forever.
  if (url.pathname.startsWith('/media/') || /\.(webp|avif|png|jpg|jpeg|svg)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // Menu and marketplace reads: serve instantly, refresh in the background.
  if (url.pathname.startsWith('/api/storefront/menu') || url.pathname.startsWith('/api/marketplace/vendors')) {
    event.respondWith(staleWhileRevalidate(request, MENU_CACHE));
    return;
  }

  // Navigations: network first so a menu edit shows up, with the shell as the fallback
  // when the connection drops entirely.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE));
    return;
  }

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return hit ?? Response.error();
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  // Return the cached copy immediately if we have one; the refresh continues regardless.
  if (hit) {
    void network;
    return hit;
  }
  const response = await network;
  return response ?? Response.error();
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request)) ?? (await cache.match('/offline')) ?? Response.error();
  }
}

/*
 * Push.
 *
 * The payload is JSON from the server. A push that arrives with nothing usable still has
 * to show *something* — Chrome revokes the permission of a site that receives a push and
 * shows no notification, so the fallback here is not politeness, it is survival.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* not JSON — fall through */ }

  event.waitUntil(
    self.registration.showNotification(data.title || 'FoodHub', {
      body: data.body || 'You have an order update.',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Collapses successive updates about the same order instead of stacking five.
      tag: data.tag || 'foodhub',
      renotify: true,
      data: { url: data.url || '/' },
    }),
  );
});

/** Focus an already-open tab rather than piling up new ones. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url) && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
