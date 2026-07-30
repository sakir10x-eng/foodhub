# Deployment

Live: **https://goodfood.72-61-244-150.sslip.io**

| | |
|---|---|
| Marketplace | <https://goodfood.72-61-244-150.sslip.io> |
| Storefronts | <https://kacchi-bhai.goodfood.72-61-244-150.sslip.io> · <https://pizza-shack.goodfood.72-61-244-150.sslip.io> · <https://chai-adda.goodfood.72-61-244-150.sslip.io> |
| Vendor admin | <https://admin.goodfood.72-61-244-150.sslip.io> (vendor logins) |
| **Superadmin console** | same host as `admin@foodhub.test` — the login redirects to `/platform` |
| Host | `72.61.244.150` (`srv1729440`, Ubuntu 24.04) — a **shared** box running 8 other stacks |
| Path | `/opt/foodhub` |

Seeded logins: `kacchi-bhai@foodhub.test`, `pizza-shack@foodhub.test`, `chai-adda@foodhub.test`,
`admin@foodhub.test`, `customer@foodhub.test` — password `password123`.

---

## Shape of the deployment

The box already runs Traefik on :80/:443 with a Let's Encrypt resolver, plus eight
unrelated stacks. This deployment is therefore built to be a **good tenant**:

- **No host ports are published.** Traefik discovers the containers by label and connects
  to their bridge IPs. Nothing here can collide with another project's port.
- **Postgres and Redis are private to the stack** — their own containers, their own
  volumes, no host binding. The box's other Postgres instances are untouched.
- **Everything is one Compose project** (`name: foodhub`), so it starts, stops and is
  removed as a unit.

```
Traefik (host net, :443, letsencrypt)
  ├── goodfood…            ─┐
  ├── kacchi-bhai.goodfood… │  /api /media /realtime /health → api:4000   (priority 100)
  ├── pizza-shack.goodfood… ├─ everything else               → web:3000   (priority 10)
  ├── chai-adda.goodfood…  ─┘
  └── admin.goodfood…         everything                     → admin:3001 (priority 50)
                              (/api on this host also → api)
```

**One image, three services.** `infra/prod.Dockerfile` builds api + web + admin once and
the three containers run it with different commands. On a 2-core box, three separate
images would repeat the slowest step (`npm ci`) three times and carry three copies of
`node_modules`.

**Same-origin API.** `/api` is routed on *every* hostname, so the browser never makes a
cross-origin request — no CORS, and a vendor's custom domain works with no extra config.
SSR bypasses the edge entirely via `API_INTERNAL_URL=http://api:4000`.

---

## Deploying a change

```bash
# from the repo root, on your machine
COPYFILE_DISABLE=1 tar czf /tmp/foodhub-src.tgz \
  --exclude=node_modules --exclude=.next --exclude=dist --exclude=.git \
  --exclude=storage --exclude='.env*' --exclude='._*' .
scp -i ~/.ssh/dokanai_deploy /tmp/foodhub-src.tgz root@72.61.244.150:/opt/foodhub/

ssh -i ~/.ssh/dokanai_deploy root@72.61.244.150
cd /opt/foodhub && tar xzf foodhub-src.tgz && rm foodhub-src.tgz
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

`COPYFILE_DISABLE=1` is not optional: macOS `tar` otherwise adds `._*` AppleDouble files
that break the Next.js build. Migrations run automatically on API start
(`prisma migrate deploy`), so a schema change needs no separate step.

### Adding a vendor hostname

Traefik can only obtain an HTTP-01 certificate for a hostname it knows, so vendor
subdomains are listed explicitly. Append to `TRAEFIK_WEB_RULE` **and**
`TRAEFIK_ALL_HOSTS_RULE` in `/opt/foodhub/.env.prod`, then `up -d`:

```
TRAEFIK_WEB_RULE=Host(`goodfood…`) || Host(`new-vendor.goodfood…`) || …
```

> Traefik v3's `Host()` takes **exactly one** hostname. The v2 comma-separated form
> (`Host(\`a\`,\`b\`)`) parses but is rejected at runtime with
> *"unexpected number of parameters"* — and the router then silently does not exist, so
> every request 404s. Use `||`.

**For unbounded vendor-owned custom domains** this list does not scale — the real answer
is Caddy's on-demand TLS (the `Caddyfile` in this repo, whose `ask` endpoint is already
implemented at `/api/internal/caddy/ask`) or a DNS-01 wildcard. Neither is possible on
`sslip.io`, which we do not control.

---

## What needs real credentials

Everything below works with the transport unconfigured — the code logs instead of sending,
so nothing breaks — but none of it reaches a customer until the keys are in `.env.prod`.

| Feature | Variables | Notes |
|---|---|---|
| SMS | `SMS_API_KEY`, `SMS_SENDER_ID` | sms.net.bd, used for any vendor who has not connected their own. Order copy is deliberately ASCII: one Bengali character makes a message UCS-2 and triples the per-message cost. |
| bKash (ours) | `BKASH_APP_KEY`, `BKASH_APP_SECRET`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_SANDBOX` | Tokenized Checkout, used for **marketplace** orders. Preferred over SSLCommerz when set. |
| WhatsApp | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | Meta Cloud API, same number as the ordering bot. Templates must be pre-approved — order updates are almost always outside the 24-hour window. |
| Email | `MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAIL_FROM` | Vendor-facing only (invoices, summaries). |
| Web push | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | **Already set on this box.** Generate with `npx web-push generate-vapid-keys`. |
| SSLCommerz (ours) | `SSLCZ_STORE_ID`, `SSLCZ_STORE_PASSWORD` | Fallback for cards and other wallets. Until a gateway exists the demo flag below stands in. |
| Maps | `NEXT_PUBLIC_GOOGLE_MAPS_KEY`, `GOOGLE_MAPS_SERVER_KEY` | **Optional.** Without them the address picker and the vendor's delivery-area editor draw OpenStreetMap tiles and geocode through Nominatim — no key, no billing, fully working. Set them to upgrade to Google, which has better Bangladeshi address data. Two separate keys on purpose: the `NEXT_PUBLIC_` one is inlined into the browser bundle and should be **referrer**-restricted; the server one never leaves the API and should be **IP**-restricted. Enable Maps JavaScript API + Geocoding API. The browser key is a **build arg** — a rebuild is required for it to take effect. |

### What each vendor supplies themselves

Three things are **per-vendor**, not platform-wide, because they belong to the vendor's own
brand and accounts. All are entered in the vendor panel and stored AES-256-GCM encrypted;
none is ever readable back, by anyone.

| Vendor setting | Where | Why it is theirs, not ours |
|---|---|---|
| Payment gateway | Settings → Your payment gateway | Mode A money goes customer → vendor directly. bKash asks for four values (app key, app secret, merchant username, merchant password) — a half-filled form is refused by name rather than failing later at the first payment. |
| SMS account | Settings → Order text messages | So order texts carry the restaurant's masked sender ID. A confirmation signed "FoodHub" for an order placed on their own domain reads as a scam. Falls back to ours until they connect one. |
| Ad pixels | Settings → Advertising pixels | Meta / TikTok / GA4 IDs from the vendor's own ad accounts. |

### bKash notes

- **Sandbox and live are different credentials** and different hosts. The sandbox checkbox
  in the panel picks the host; using live keys against sandbox fails at the token grant.
- The **callback is the customer's browser**, not a server webhook: bKash redirects to
  `/api/payments/bkash/callback?paymentID=…&status=…`, which executes the payment and then
  redirects the customer to their order page. It is safe to hit twice.
- Tokens are cached per merchant for their full life minus five minutes — bKash throttles
  merchants who request one per payment.

## Demo payments

This deployment has **no merchant account**, so `DEMO_ALLOW_MOCK_PAYMENTS=true` is set in
`.env.prod`. That turns on a local "confirm payment" page in place of a real gateway so
the whole money pipeline — advance charged, order part-paid, delivered, ledger settled —
can be walked end to end.

> **Never set this on a deployment that takes real orders.** With it on, any order can be
> marked paid from a URL. It is off by default and has to be opted into by name.

The vendor-facing consequence, which is enforced regardless of the flag: a vendor cannot
switch on a 50%/100% advance until they have connected a gateway. An advance closes cash
on delivery, so without one their storefront would accept nothing at all.

## Operations

```bash
cd /opt/foodhub
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
docker compose -f docker-compose.prod.yml --env-file .env.prod logs api --tail 100

# metrics (not routed publicly — deliberately, it would leak vendor names and volumes)
docker exec foodhub-api-1 wget -qO- http://127.0.0.1:4000/metrics | head

# bring an existing demo database up to the current seed WITHOUT wiping it
# (adds pickup, the drawn delivery area, offer prices and dish verdicts)
docker exec foodhub-api-1 npx ts-node -T prisma/backfill-demo.ts

# reseed demo data — TWO steps. The DB seed deletes the image rows, so on its own it
# leaves every storefront blank. The second command re-uploads the demo imagery through
# the real media pipeline and must run from a machine with the repo checked out.
docker exec foodhub-api-1 npx ts-node -T prisma/seed.ts
node scripts/seed-images.mjs https://goodfood.72-61-244-150.sslip.io

# database shell
docker exec -it foodhub-postgres-1 psql -U foodhub -d foodhub

# backup
docker exec foodhub-postgres-1 pg_dump -U foodhub foodhub | gzip > foodhub-$(date +%F).sql.gz
```

Logs are structured JSON with a request id and tenant on every line, so
`docker logs foodhub-api-1 | jq 'select(.tenantId=="…")'` works.

---

## Not configured (features degrade cleanly)

| Unset | Effect |
|---|---|
| `SSLCZ_STORE_ID` / `SSLCZ_STORE_PASSWORD` | Online payment is unavailable; cash-on-delivery works. In production the API **refuses to issue a mock session** — the mock exists only outside production. |
| `ANTHROPIC_API_KEY` | The AI ordering assistant reports itself unavailable and the storefront does not render the chat bubble. |
| `SENTRY_DSN` | Error reporting is a no-op. |
| `WHATSAPP_APP_SECRET` | The WhatsApp webhook refuses every request rather than trusting unsigned input. |

Set any of these in `/opt/foodhub/.env.prod` and re-run `up -d`.

---

## Demo imagery

`node scripts/seed-images.mjs https://goodfood.72-61-244-150.sslip.io` gives every vendor a
logo, a cover and a photo on every dish. It goes through the **real HTTP API** — vendor
login, `POST /media/upload`, `PATCH` the product — so it exercises auth, the tenant guard
and the whole pipeline (resize → WebP ladder → LQIP → queued AVIF) exactly as a vendor
uploading from the panel would. Re-running is safe: dishes that already have an image are
skipped.

Photos come from **TheMealDB**, a free recipe API — illustrative demo content for
fictional restaurants, not photographs of those specific dishes. Anything it doesn't know
(drinks, singara, logos) is generated locally as branded vector artwork, so no card is
ever left with a placeholder.

> After changing anything about how images are serialised, **flush the menu cache** or the
> storefront will keep serving the pre-change payload for up to the TTL:
> `docker exec foodhub-redis-1 redis-cli --scan --pattern 'menu*' | xargs -n1 docker exec foodhub-redis-1 redis-cli DEL`

## Four bugs this deployment surfaced

All four were real defects that local testing had masked, now fixed:

1. **Static assets 404'd on the marketplace host.** The Next.js middleware rewrote every
   path into `/m/…`, which swallowed `public/` files — the service worker and PWA icons
   returned 404. Local tests passed because they hit `127.0.0.1`, which is not the
   marketplace host and took the storefront branch. The matcher now excludes any path
   containing a dot.
2. **`HEAD` requests were told `no-store`.** The cache interceptor only recognised `GET`,
   so a CDN revalidating with `HEAD` was instructed not to cache. `HEAD` is served by the
   `GET` handler and now gets the same headers.
3. **Broken images on retina screens.** The client emitted a `srcset` listing all five
   widths, but the upload pipeline never upscales — it only writes derivatives up to the
   source width. A phone picking `960w` on an 800px source got a 404, and a browser does
   not recover from that. The client now mirrors the pipeline's rule.
4. **AVIF was generated and never served.** The queued encoder was writing AVIF
   derivatives that nothing ever requested — the component only emitted an `<img>` with a
   WebP `srcset`. It now renders a `<picture>` offering AVIF first, gated on `hasAvif` so
   a listed source can never 404. On these photos that is **5 KB instead of 42 KB**.
