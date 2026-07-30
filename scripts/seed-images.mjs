#!/usr/bin/env node
/**
 * Seed demo imagery for the demo vendors.
 *
 * Deliberately goes through the real HTTP API — vendor login, POST /media/upload,
 * PATCH the product — rather than writing rows directly. That means it exercises auth,
 * the tenant guard and the whole image pipeline (resize -> WebP ladder -> LQIP -> queued
 * AVIF) exactly as a vendor uploading from the admin panel would.
 *
 * Dish photos come from TheMealDB, a free recipe API. They are illustrative demo content
 * for fictional restaurants, not photographs of these specific dishes. Anything without a
 * sensible match (drinks, logos, covers) is generated locally as branded artwork, so no
 * card is ever left with a placeholder.
 *
 *   node scripts/seed-images.mjs https://goodfood.72-61-244-150.sslip.io
 */
import sharp from 'sharp';

const BASE = (process.argv[2] || 'http://127.0.0.1:4000').replace(/\/$/, '');
const PASSWORD = process.env.SEED_PASSWORD || 'password123';

/** Search terms tried in order until TheMealDB returns a hit. */
const DISH_QUERIES = {
  'Mutton Kacchi (Full)': ['lamb biryani', 'lamb'],
  'Mutton Kacchi (Half)': ['lamb rogan josh', 'lamb'],
  'Chicken Biryani': ['chicken mandi', 'chicken curry'],
  'Beef Tehari': ['beef brisket', 'beef'],
  'Beef Shik Kebab': ['adana kebab', 'kebab'],
  'Chicken Reshmi Kebab': ['red curry chicken kebabs', 'chicken'],
  'Jali Kebab': ['kofta', 'meatball'],
  Firni: ['rice pudding', 'pudding'],
  'Margherita (12")': ['pizza express margherita', 'pizza'],
  'Pepperoni (12")': ['pizza', 'cassava pizza'],
  'BBQ Chicken (12")': ['bbq', 'chicken'],
  'Four Cheese (12")': ['cheese', 'pizza'],
  'Garlic Bread': ['garlic', 'bread'],
  'Buffalo Wings (6)': ['wings', 'chicken'],
  'Garden Salad': ['shopska salad', 'salad'],
  'Malai Cha': ['tea', 'masala'],
  'Masala Cha': ['masala', 'tea'],
  'Lebu Cha': ['tea', 'lemon'],
  'Singara (2)': ['samosa', 'pakora'],
  'Samucha (2)': ['samosa', 'kofta'],
  'Toast Biscuit': ['cookies', 'biscuit'],
};

/** Dishes with no sensible photo match get generated artwork instead of a placeholder. */
const GENERATED = {
  'Singara (2)': { kind: 'pastry', hue: '#C98B3A', label: 'Singara' },
  Borhani: { emoji: 'glass', hue: '#7BA05B', label: 'Borhani' },
  'Lemon Mint': { emoji: 'glass', hue: '#8CC63F', label: 'Lemon Mint' },
  'Coke 500ml': { emoji: 'bottle', hue: '#C0392B', label: 'Coke' },
  'Sparkling Water': { emoji: 'bottle', hue: '#4A90D9', label: 'Sparkling' },
};

const VENDORS = [
  { email: 'kacchi-bhai@foodhub.test', cover: ['lamb biryani', 'lamb'], brand: '#B3341F', name: 'Kacchi Bhai' },
  { email: 'pizza-shack@foodhub.test', cover: ['pizza express margherita', 'pizza'], brand: '#1F7A4D', name: 'The Pizza Shack' },
  { email: 'chai-adda@foodhub.test', cover: ['tea', 'masala'], brand: '#8A5A2B', name: 'Chai Adda' },
];

const mealCache = new Map();

async function mealPhoto(queries) {
  for (const q of queries) {
    if (mealCache.has(q)) {
      if (mealCache.get(q)) return mealCache.get(q);
      continue;
    }
    try {
      const res = await fetch(`https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`);
      const body = await res.json();
      const meal = body?.meals?.[0];
      const url = meal?.strMealThumb ?? null;
      mealCache.set(q, url);
      if (url) return url;
    } catch {
      // Transient failure: leave it uncached so a later dish can retry the same term.
    }
  }
  return null;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ───────────────────────────────────────────────── generated artwork ─── */

/** Simple flat-vector glassware, so a drink card reads as a drink at thumbnail size. */
function drinkSvg({ hue, label, kind }) {
  const glass =
    kind === 'bottle'
      ? `<path d="M270 180h60v40l22 46v214a20 20 0 0 1-20 20h-64a20 20 0 0 1-20-20V266l22-46z"
             fill="rgba(255,255,255,.92)"/>
         <rect x="248" y="300" width="104" height="150" rx="10" fill="${hue}" opacity=".55"/>`
      : `<path d="M232 190h136l-18 250a26 26 0 0 1-26 24h-48a26 26 0 0 1-26-24z"
             fill="rgba(255,255,255,.92)"/>
         <path d="M243 290h114l-13 175a14 14 0 0 1-14 13h-60a14 14 0 0 1-14-13z" fill="${hue}" opacity=".6"/>
         <ellipse cx="300" cy="190" rx="68" ry="12" fill="rgba(255,255,255,.98)"/>`;

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${hue}" stop-opacity=".22"/>
        <stop offset="1" stop-color="${hue}" stop-opacity=".62"/>
      </linearGradient>
    </defs>
    <rect width="600" height="600" fill="#F6F4F1"/>
    <rect width="600" height="600" fill="url(#bg)"/>
    <circle cx="300" cy="320" r="205" fill="rgba(255,255,255,.30)"/>
    ${glass}
    <text x="300" y="545" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif"
          font-size="40" font-weight="700" fill="#12100E" opacity=".75">${label}</text>
  </svg>`);
}

/** Flat-vector savoury pastry — for dishes no photo API knows (singara, samucha…). */
function pastrySvg({ hue, label }) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${hue}" stop-opacity=".20"/>
        <stop offset="1" stop-color="${hue}" stop-opacity=".58"/>
      </linearGradient>
      <linearGradient id="crust" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#E8B96B"/>
        <stop offset="1" stop-color="#C98B3A"/>
      </linearGradient>
    </defs>
    <rect width="600" height="600" fill="#F6F4F1"/>
    <rect width="600" height="600" fill="url(#bg)"/>
    <ellipse cx="300" cy="452" rx="176" ry="30" fill="#12100E" opacity=".12"/>
    <path d="M300 150 L432 430 H168 Z" fill="url(#crust)" stroke="#A9722C" stroke-width="8" stroke-linejoin="round"/>
    <path d="M300 150 L300 430" stroke="#A9722C" stroke-width="6" opacity=".55"/>
    <path d="M236 300 q64 34 128 0" stroke="#A9722C" stroke-width="6" fill="none" opacity=".5"/>
    <text x="300" y="545" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif"
          font-size="40" font-weight="700" fill="#12100E" opacity=".75">${label}</text>
  </svg>`);
}

/** Vendor monogram: initials on the brand colour. Reads clearly at 64px. */
function logoSvg(name, brand) {
  const initials = name
    .replace(/^The\s+/i, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <rect width="512" height="512" rx="112" fill="${brand}"/>
    <circle cx="512" cy="0" r="190" fill="#ffffff" opacity=".10"/>
    <text x="256" y="286" text-anchor="middle" dominant-baseline="middle"
          font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif"
          font-size="210" font-weight="800" fill="#ffffff">${initials}</text>
  </svg>`);
}

/** A photo cover, darkened under a brand wash so white header text stays readable. */
async function coverFromPhoto(photo, brand) {
  const base = await sharp(photo).resize(1600, 700, { fit: 'cover', position: 'centre' }).toBuffer();
  const wash = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="700">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="${brand}" stop-opacity=".18"/>
      <stop offset="1" stop-color="#12100E" stop-opacity=".42"/>
    </linearGradient></defs>
    <rect width="1600" height="700" fill="url(#g)"/>
  </svg>`);
  return sharp(base).composite([{ input: wash, blend: 'over' }]).jpeg({ quality: 86 }).toBuffer();
}

/* ─────────────────────────────────────────────────────────── API calls ─── */

async function login(email) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status}`);
  return (await res.json()).accessToken;
}

async function upload(token, buffer, filename) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename);
  const res = await fetch(`${BASE}/api/media/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`upload failed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return (await res.json()).id;
}

async function patch(token, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`patch ${path} failed ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

/* ────────────────────────────────────────────────────────────── driver ─── */

async function run() {
  console.log(`Seeding demo imagery against ${BASE}\n`);
  let images = 0;

  for (const vendor of VENDORS) {
    const token = await login(vendor.email);
    console.log(`${vendor.name}`);

    // ── logo
    const logoId = await upload(token, await sharp(logoSvg(vendor.name, vendor.brand)).png().toBuffer(), 'logo.png');
    images++;

    // ── cover
    let coverId = null;
    const coverUrl = await mealPhoto(vendor.cover);
    if (coverUrl) {
      const cover = await coverFromPhoto(await download(coverUrl), vendor.brand);
      coverId = await upload(token, cover, 'cover.jpg');
      images++;
    }
    await patch(token, '/vendor/settings', { logoId, ...(coverId ? { coverId } : {}) });
    console.log(`  ✓ logo${coverId ? ' + cover' : ''}`);

    // ── dishes
    const products = await (
      await fetch(`${BASE}/api/vendor/menu/products`, { headers: { Authorization: `Bearer ${token}` } })
    ).json();

    for (const product of products) {
      if (product.image) continue; // already has one — re-running is safe
      try {
        let buffer = null;
        const generated = GENERATED[product.name];
        if (generated) {
          const svg =
            generated.kind === 'pastry'
              ? pastrySvg({ hue: generated.hue, label: generated.label })
              : drinkSvg({ hue: generated.hue, label: generated.label, kind: generated.emoji });
          buffer = await sharp(svg).jpeg({ quality: 88 }).toBuffer();
        } else {
          const url = await mealPhoto(DISH_QUERIES[product.name] ?? [product.name]);
          if (url) {
            // Square crop: every menu row renders in a square slot.
            buffer = await sharp(await download(url)).resize(800, 800, { fit: 'cover' }).jpeg({ quality: 86 }).toBuffer();
          }
        }
        if (!buffer) {
          // No photo anywhere: fall back to branded artwork so the card is never blank.
          buffer = await sharp(pastrySvg({ hue: '#C98B3A', label: product.name.split('(')[0].trim() }))
            .jpeg({ quality: 88 })
            .toBuffer();
        }
        const imageId = await upload(token, buffer, 'dish.jpg');
        await patch(token, `/vendor/menu/products/${product.id}`, { imageId });
        images++;
        console.log(`  ✓ ${product.name}`);
      } catch (err) {
        console.log(`  ✗ ${product.name}: ${err.message}`);
      }
    }
    console.log('');
  }

  console.log(`Done — ${images} images uploaded through the media pipeline.`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
