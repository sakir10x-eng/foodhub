-- Typo-tolerant instant search for the marketplace.
-- Postgres pg_trgm is plenty up to ~100k items; swap in Meilisearch/Typesense at scale
-- (the query lives behind SearchService, so only that one file changes).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Menu-item search. GIN + trigram ops handles "birani" -> "Biryani".
CREATE INDEX IF NOT EXISTS products_name_trgm_idx
  ON "products" USING GIN ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS products_description_trgm_idx
  ON "products" USING GIN ("description" gin_trgm_ops);

-- Vendor search.
CREATE INDEX IF NOT EXISTS tenants_name_trgm_idx
  ON "tenants" USING GIN ("name" gin_trgm_ops);

-- "Near me": a bounding-box prefilter on this index cuts the candidate set before the
-- haversine expression runs, so we need no PostGIS/earthdistance dependency.
CREATE INDEX IF NOT EXISTS tenants_geo_idx
  ON "tenants" ("lat", "lng")
  WHERE "lat" IS NOT NULL AND "lng" IS NOT NULL;

-- Marketplace listing feed: only open, listed vendors, newest first.
CREATE INDEX IF NOT EXISTS tenants_marketplace_feed_idx
  ON "tenants" ("listedOnMarketplace", "isOpen", "createdAt" DESC);

-- Settlement rollup scans unsettled VENDOR_PAYABLE rows per tenant per period.
CREATE INDEX IF NOT EXISTS ledger_unsettled_idx
  ON "ledger_entries" ("tenantId", "createdAt")
  WHERE "settlementId" IS NULL;
