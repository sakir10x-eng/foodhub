# FoodHub

A dual-channel commerce platform for food vendors in Bangladesh. Two products, **one
backend, one catalog, one order pipeline**:

| | Mode A — vendor storefront | Mode B — mother marketplace |
|---|---|---|
| Domain | the vendor's own | ours |
| Gateway | the **vendor's** merchant account | **our** account, split-payout |
| We charge | fixed monthly fee | commission per order |
| Money touches us | never | only our commission |
| Enforced by | suspending the storefront | funds flow through the gateway |

A vendor adds a dish once. It can appear on their own branded site *and* on our
marketplace, and both channels drop orders into the same admin queue. Only the money
differs.

**Build Mode A first, then flip Mode B on as a toggle.** By the time the marketplace
launches, vendors and their menus are already in the system — which is how you get out
of the marketplace chicken-and-egg problem. That sequencing is the point; don't launch
both at once.

---

## Run it

Requires Node 20+ and a Postgres 16 you can reach. No Docker needed for development.

```bash
cp .env.example .env          # then set DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
npm install
npm run build:shared
npm run db:migrate            # creates the database and applies migrations
npm run db:seed               # three demo restaurants, ~30 dishes
npm run dev                   # api :4000, web :3000, admin :3001
```

| | |
|---|---|
| Marketplace | <http://lvh.me:3000> |
| Storefronts | <http://kacchi-bhai.lvh.me:3000> · <http://pizza-shack.lvh.me:3000> · <http://chai-adda.lvh.me:3000> |
| Vendor admin | <http://lvh.me:3001> |
| API | <http://127.0.0.1:4000/api> |

`lvh.me` resolves `*.lvh.me` to `127.0.0.1`, so subdomain routing works with no
`/etc/hosts` edits. Seeded logins: `kacchi-bhai@foodhub.test` (and the other two slugs),
`admin@foodhub.test`, `customer@foodhub.test` — password `password123`.

`chai-adda` is deliberately **not** listed on the marketplace: it demonstrates a
Mode-A-only vendor, whose storefront works fully while the marketplace 404s them.

Prefer containers? `docker compose up` runs the whole stack behind Caddy.

---

## Layout

```
apps/api          NestJS + Prisma — all business logic, both channels
apps/web          Next.js — storefront AND marketplace, routed by Host header
apps/admin        Next.js — vendor panel (menu, live orders, payouts, domains)
packages/shared   money, pricing, order state machine, zod schemas — one source of truth
Caddyfile         edge: on-demand TLS for every vendor's custom domain
infra/            Dockerfiles
```

`packages/shared` is what keeps the two channels honest: `priceCart()` is the *only*
place an order total is computed, and both the browser and the server import the same
zod schemas, so validation rules can't drift.

---

## The parts that carry the risk

### Tenant isolation is enforced, not remembered

Single database, shared schema, `tenantId` on every tenant-scoped table. Rather than
trusting every future `where` clause, a Prisma client extension
([`tenant-guard.ts`](apps/api/src/prisma/tenant-guard.ts)) reads an AsyncLocalStorage
scope and **rejects any query it cannot confine to one tenant**:

```ts
await prisma.db.product.findMany();                       // throws — no scope bound
await TenantContext.runAsTenant(id, () => …);             // scoped to one vendor
await TenantContext.runAsPlatform('marketplace feed', …); // audited escape hatch
```

Fail-closed is the whole point: a forgotten filter becomes a 500 in our logs, never a
cross-tenant read. `grep -r runAsPlatform` is a complete audit of every place we read
across tenants. Covered by
[`tenant-isolation.spec.ts`](apps/api/test/tenant-isolation.spec.ts), which attacks the
guard directly — cross-tenant `findUnique`, `update`, `delete`, `deleteMany`, forged
`tenantId` on create, and isolation inside transactions.

> One subtlety worth knowing: Prisma promises are lazy, so a scope helper that *returns*
> a query without awaiting it exits before the query runs. `runAsTenant`/`runAsPlatform`
> await internally so no call site can get this wrong.

### Money is integers, and the two channels never merge

Every monetary value is an integer of **poisha** (1 BDT = 100 poisha). No floats, ever.

Commission is computed only for `MARKETPLACE` orders. On `OWN_STORE` the money goes
customer → vendor directly, so a per-order commission would depend on vendors
self-reporting turnover — unenforceable. Mode A is subscription-only, enforced by
suspending the storefront (the admin panel stays reachable so they can pay).

The ledger separates two kinds of row: **balance-affecting** (`VENDOR_PAYABLE`,
`REFUND`, `SETTLEMENT`) whose running `balanceAfter` is exactly what we owe a vendor, and
**memo** rows (`CUSTOMER_PAYMENT`, `COMMISSION`) recorded for audit without conflating
gross with payable. Settlement claims unsettled entries under `Serializable`, so a
replayed `DELIVERED` cannot pay a vendor twice.

Cash-on-delivery on the marketplace inverts: the rider took the cash, so our commission
becomes a *receivable* that nets off the vendor's next payout.

### Custom domains provision themselves

A vendor points a CNAME at the edge and adds the hostname in their panel. Caddy's
on-demand TLS asks `/api/internal/caddy/ask` before issuing a certificate, which checks
the `domains` table — without that gate, anyone could aim DNS at us and burn our Let's
Encrypt rate limit. No deploy, no support ticket.

### Regulatory posture (Bangladesh Bank)

Holding and settling customer funds can require PSP/aggregator approval. Mode B therefore
requests **SSLCommerz split-payout** so the gateway settles vendors directly and only our
commission ever lands with us. Mode A carries no exposure at all — another reason to
launch it first. Don't design a fund-holding flow until it is licensed.

---

## Phase 3 — scale and smoothness

- **PWA.** Installable, with a hand-written service worker: the shell is precached, menus
  and images are stale-while-revalidate, and **anything touching money or an order is
  never cached**. A stale cart total is worse than a spinner. Falls back to an offline
  page; shows an offline banner rather than failing silently.
- **Observability.** Structured JSON logs carrying a request id and tenant on every line,
  a Prometheus `/metrics` endpoint (RED metrics, order volume, AI token spend, slow
  queries), and an optional Sentry hook that scrubs credentials and masks phone numbers
  before anything leaves the box. `X-Request-Id` is honoured inbound and echoed back, so
  one id traces a complaint from the edge through the API to the queue worker.
- **Noisy-neighbour protection.** Per-IP *and* per-tenant rate limits, backed by an atomic
  Redis `INCR`. One vendor's runaway integration degrades that vendor, not the platform.
  The AI endpoint has its own much lower ceiling, because each turn costs the vendor money.
- **Edge caching.** Public reads carry `s-maxage` + `stale-while-revalidate` and an ETag;
  a cache expiry refreshes in the background instead of stalling a customer mid-scroll.
  `Vary: X-Tenant-Host` — without it a CDN could serve one vendor's menu on another's
  domain. Everything not explicitly marked cacheable is `no-store`.
- **DB scaling.** Optional read replica (`REPLICA_DATABASE_URL`) for analytics and
  browsing, PgBouncer config for transaction pooling, slow-query logging as a metric.
  Anything that reads a value in order to write it — balances, stock, settlement — stays
  on the primary, because replicas lag.
- **k6 load profiles** shaped like real traffic: `load/peak.js` reproduces the iftar/dinner
  vertical ramp at a realistic 20:1 browse-to-order ratio, and treats a 429 as the rate
  limiter working rather than a failure.

## Phase 4 — the moat

- **Vendor analytics.** Best-sellers, peak hours in Asia/Dhaka (a vendor staffs against
  their own wall clock, not UTC), revenue trend split by channel, and a short list of
  *actionable* inventory alerts — the "marked sold out but sold 12 last week" case costs
  money every hour it goes unnoticed.
- **Reorder + recommendations.** Co-purchase counts, not machine learning: on a 30-item
  menu that beats an embedding model on accuracy and explainability, costs one indexed
  read, and can be debugged by looking at a table. Reorder quotes *current* prices, never
  the old snapshot — showing a stale price would be a broken promise at checkout.
- **Loyalty + wallet.** Per-vendor, keyed by phone so guests earn too (most BD food orders
  are guest checkouts). Points are awarded on `DELIVERED`, never at checkout, so a
  cancelled order can't mint them; redemption is debited inside the order transaction and
  re-checked there, so a concurrent order can't spend the same balance twice.
- **AI ordering assistant.** Chat-to-order on the storefront, plus a signed WhatsApp
  webhook. Built on `claude-opus-5` via the SDK tool runner. Two decisions carry the
  reliability: the **real menu with real ids and prices is injected into the system
  prompt** (a bot that invents a dish or a price is worse than no bot) with
  `cache_control: ephemeral` so repeat turns read it at ~10% of input cost; and the model
  **never writes to the database** — its tools mutate a draft cart, and orders go through
  the same `CheckoutService` the web uses, which re-prices everything server-side and
  validates every product id against the vendor's catalog.

## Performance is a gate, not a goal

Baked in from the start, because none of it bolts on later:

- **Menus cached like static assets.** Keyed by `menuVersion`; an edit bumps the version
  so old keys become unreachable rather than needing a cache sweep. A sold-out toggle
  *patches* the cached payload instead of invalidating it — dinner rush shouldn't cold-start
  every render.
- **Image ladder.** Upload → EXIF-rotate → cap at 1600px → WebP at five widths + a 20px
  base64 LQIP, inline. AVIF is encoded off the request path and only emitted once
  `hasAvif` flips, because a browser will *not* fall back if a listed `<source>` 404s.
- **Skeletons, never spinners.** Grey blocks read as "nearly there"; a spinner reads as
  "broken".
- **Optimistic UI.** Add-to-cart, quantity, availability toggle and order-status advance
  all update on the current tick and roll back on failure.
- **≤3-tap checkout.** Address restored from the last order, COD preselected.
- **Lighthouse in CI.** LCP > 2.5s or CLS > 0.1 fails the build.

Shared JS is ~103 kB for the storefront; the menu is server-rendered HTML on first paint.

---

## Dev notes

- **No Redis?** Cache and queue detect `REDIS_URL`. Unset, they run an in-process driver
  so `npm run dev` needs no infrastructure; set it and BullMQ takes over with retries and
  durability. Same API either way.
- **No payment gateway?** With no credentials configured the API issues a clearly-labelled
  **mock** session so the full pipeline — order → IPN → settlement — is walkable. It
  refuses to do this in production.
- **Vendor gateway keys** are AES-256-GCM encrypted at rest and never readable back; the
  panel shows only whether something is saved.

- **No Anthropic key?** The assistant reports itself unavailable and the storefront simply
  doesn't render the chat bubble — same graceful-degradation pattern as the gateway.
- **No Sentry?** `@sentry/node` is an optional dependency; with no DSN every call is a
  no-op, so CI and local dev need no account.

```bash
npm test                                  # 50 tests: isolation, pricing, ledger, settlement, loyalty
npm run db:studio                         # browse the data
k6 run load/peak.js                       # iftar-rush load profile
curl localhost:4000/metrics               # Prometheus scrape
```

---

## Not built (deliberately)

- **Multi-vendor carts** — forces split payments and split delivery. One vendor per order,
  like real Foodpanda.
- **Platform rider fleet** — vendor self-delivery keeps this capital-light. `deliveryZones`
  already models the fee structure a fleet would need.
- **Commission on own_store** — unenforceable by construction. See above.
- **Meilisearch** — `pg_trgm` is fast well past first-year volume, and search lives behind
  one service method, so swapping it touches one file.
- **Multi-region** — nothing in the data model prevents it; there is no demand yet.
