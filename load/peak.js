import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * Iftar / dinner-rush load profile.
 *
 * Food ordering is not steady traffic. It is flat all afternoon and then, at iftar or at
 * 8pm, a near-vertical ramp: everyone in the city opens the app inside the same ten
 * minutes. A test that averages load over an hour tells you nothing about that. This
 * profile reproduces the shape — a fast ramp to peak, a sustained plateau, then a drop —
 * and asserts on the p95 the customer actually experiences during the plateau.
 *
 * The read:write ratio matters too. Real traffic is overwhelmingly browsing: roughly
 * 20 menu views per order placed. Hammering only /checkout would exercise a code path
 * that in production is 5% of requests.
 *
 *   BASE_URL=http://127.0.0.1:4000 k6 run load/peak.js
 *   PROFILE=soak k6 run load/peak.js
 */

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:4000';
const VENDOR_HOST = __ENV.VENDOR_HOST || 'kacchi-bhai.lvh.me';
const PROFILE = __ENV.PROFILE || 'peak';

const menuLatency = new Trend('menu_latency', true);
const checkoutLatency = new Trend('checkout_latency', true);
const ordersPlaced = new Counter('orders_placed');
const businessErrors = new Rate('business_errors');

const PROFILES = {
  // The real shape: calm, sudden ramp, ten-minute plateau, drain.
  peak: {
    stages: [
      { duration: '30s', target: 20 },
      { duration: '1m', target: 250 },
      { duration: '3m', target: 250 },
      { duration: '30s', target: 20 },
      { duration: '30s', target: 0 },
    ],
  },
  // Does it leak or degrade when held at a normal evening for half an hour?
  soak: {
    stages: [
      { duration: '1m', target: 60 },
      { duration: '30m', target: 60 },
      { duration: '1m', target: 0 },
    ],
  },
  // Where does it actually break?
  stress: {
    stages: [
      { duration: '1m', target: 200 },
      { duration: '2m', target: 500 },
      { duration: '2m', target: 900 },
      { duration: '1m', target: 0 },
    ],
  },
};

export const options = {
  stages: PROFILES[PROFILE].stages,
  thresholds: {
    // A storefront that takes more than 800ms at p95 during the rush has failed, even
    // if nothing errored.
    'http_req_duration{kind:menu}': ['p(95)<800'],
    // Checkout is allowed to be slower — it writes — but not by much: this is the
    // moment a customer abandons.
    'http_req_duration{kind:checkout}': ['p(95)<1500'],
    // 429s are expected under stress and are a success, not a failure — they are the
    // rate limiter protecting everyone else. Only 5xx counts as broken.
    http_req_failed: ['rate<0.02'],
    business_errors: ['rate<0.05'],
    checks: ['rate>0.95'],
  },
};

export function setup() {
  const res = http.get(`${BASE}/api/storefront/menu`, { headers: { 'X-Tenant-Host': VENDOR_HOST } });
  if (res.status !== 200) {
    throw new Error(`Cannot reach the storefront menu (${res.status}). Is the API seeded and running?`);
  }
  const menu = res.json();
  const products = (menu.categories || [])
    .flatMap((c) => c.products)
    .filter((p) => p.isAvailable)
    .map((p) => p.id);

  if (products.length === 0) throw new Error('No available products to order — run `npm run db:seed`.');
  return { tenantId: menu.tenant.id, products };
}

export default function (data) {
  const headers = { 'X-Tenant-Host': VENDOR_HOST, 'Content-Type': 'application/json' };

  group('browse', () => {
    const res = http.get(`${BASE}/api/storefront/menu`, { headers, tags: { kind: 'menu' } });
    menuLatency.add(res.timings.duration);
    check(res, {
      'menu 200': (r) => r.status === 200,
      'menu has items': (r) => r.status === 200 && (r.json('categories') || []).length > 0,
    });
    sleep(randomBetween(0.5, 2));
  });

  group('search', () => {
    const terms = ['kacchi', 'biryani', 'borhani', 'kebab', 'chicken'];
    const q = terms[Math.floor(Math.random() * terms.length)];
    const res = http.get(`${BASE}/api/marketplace/search?q=${q}`, { tags: { kind: 'search' } });
    check(res, { 'search ok': (r) => r.status === 200 });
    sleep(randomBetween(0.3, 1));
  });

  // ~1 in 20 sessions converts, which is roughly the real ratio for a food storefront.
  if (Math.random() < 0.05) {
    group('checkout', () => {
      const items = pickItems(data.products);
      const payload = JSON.stringify({
        items,
        address: {
          name: `Load Test ${__VU}`,
          phone: `01${randomInt(700000000, 999999999)}`,
          addressLine: `House ${randomInt(1, 200)}, Road ${randomInt(1, 30)}, Dhanmondi`,
          area: 'Dhanmondi',
          city: 'Dhaka',
        },
        paymentMethod: 'COD',
      });

      const res = http.post(`${BASE}/api/storefront/checkout`, payload, {
        headers,
        tags: { kind: 'checkout' },
      });
      checkoutLatency.add(res.timings.duration);

      const created = res.status === 201;
      // A 429 is the rate limiter doing its job; a 400 is a legitimate business rule
      // (closed kitchen, below minimum). Neither is a defect — only 5xx is.
      const acceptable = created || res.status === 429 || res.status === 400;
      businessErrors.add(!acceptable);
      if (created) ordersPlaced.add(1);

      check(res, { 'checkout did not 5xx': () => res.status < 500 });
    });
  }

  sleep(randomBetween(1, 3));
}

export function teardown() {
  // Orders created here are real rows. Point this at a staging database, never at
  // production, and truncate afterwards.
  console.log('Load test complete — remember the orders it created are real.');
}

function pickItems(products) {
  const count = randomInt(1, 3);
  const chosen = new Set();
  while (chosen.size < Math.min(count, products.length)) {
    chosen.add(products[Math.floor(Math.random() * products.length)]);
  }
  return [...chosen].map((productId) => ({ productId, qty: randomInt(1, 2) }));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}
