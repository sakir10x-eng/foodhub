-- A rider gets a patch and a shift.
--
-- Purely additive: no column changes meaning, no row moves, and a database with no rider
-- areas behaves exactly as it did — every rider simply matches nothing and the shop keeps
-- assigning by hand, which is what it was doing yesterday.

-- ── on duty ─────────────────────────────────────────────────────────────────────────────
-- Off for everyone at first. Turning it on is the rider's decision, and defaulting it to
-- true would put work on the phone of somebody who has gone home.
ALTER TABLE "riders" ADD COLUMN "onDuty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "riders" ADD COLUMN "dutySince" TIMESTAMP(3);

DROP INDEX IF EXISTS "riders_isActive_idx";
CREATE INDEX "riders_isActive_onDuty_idx" ON "riders"("isActive", "onDuty");

-- ── where they go ───────────────────────────────────────────────────────────────────────
CREATE TABLE "rider_areas" (
    "id"        UUID NOT NULL,
    "riderId"   UUID NOT NULL,
    "label"     TEXT NOT NULL,
    "shape"     JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rider_areas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rider_areas_riderId_idx" ON "rider_areas"("riderId");

ALTER TABLE "rider_areas" ADD CONSTRAINT "rider_areas_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── what they have passed on ────────────────────────────────────────────────────────────
CREATE TABLE "rider_offer_skips" (
    "riderId"   UUID NOT NULL,
    "orderId"   UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rider_offer_skips_pkey" PRIMARY KEY ("riderId","orderId")
);

CREATE INDEX "rider_offer_skips_orderId_idx" ON "rider_offer_skips"("orderId");

ALTER TABLE "rider_offer_skips" ADD CONSTRAINT "rider_offer_skips_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rider_offer_skips" ADD CONSTRAINT "rider_offer_skips_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
