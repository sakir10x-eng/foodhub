-- Who the rider is, when they worked, and a way to say something has gone wrong.
--
-- Additive. Existing riders become MOTORCYCLE with a 15kg capacity, which is what they
-- were implicitly assumed to be; nothing they can currently be offered changes.

CREATE TYPE "Vehicle" AS ENUM ('BICYCLE', 'MOTORCYCLE', 'VAN', 'FOOT');
CREATE TYPE "AlertKind" AS ENUM ('ACCIDENT', 'BREAKDOWN', 'UNSAFE', 'OTHER');

ALTER TABLE "riders" ADD COLUMN "vehicle" "Vehicle" NOT NULL DEFAULT 'MOTORCYCLE';
ALTER TABLE "riders" ADD COLUMN "capacityKg" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "riders" ADD COLUMN "emergencyPhone" TEXT;

-- ── attendance, taken from the duty toggle rather than asked for twice ───────────────────
CREATE TABLE "rider_shifts" (
    "id"        UUID NOT NULL,
    "riderId"   UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt"   TIMESTAMP(3),
    CONSTRAINT "rider_shifts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rider_shifts_riderId_startedAt_idx" ON "rider_shifts"("riderId", "startedAt");

ALTER TABLE "rider_shifts" ADD CONSTRAINT "rider_shifts_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A rider already on duty when this ships gets an open shift, so their day is not lost.
INSERT INTO "rider_shifts" ("id", "riderId", "startedAt")
SELECT gen_random_uuid(), id, COALESCE("dutySince", CURRENT_TIMESTAMP)
FROM "riders" WHERE "onDuty" = true;

-- ── one tap when something has gone wrong ───────────────────────────────────────────────
CREATE TABLE "rider_alerts" (
    "id"         UUID NOT NULL,
    "riderId"    UUID NOT NULL,
    "kind"       "AlertKind" NOT NULL,
    "note"       TEXT,
    "lat"        DOUBLE PRECISION,
    "lng"        DOUBLE PRECISION,
    "resolvedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rider_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "rider_alerts_riderId_createdAt_idx" ON "rider_alerts"("riderId", "createdAt");

ALTER TABLE "rider_alerts" ADD CONSTRAINT "rider_alerts_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- How heavy one unit is, in grams. 0 = not weighed, which is what cooked food stays at.
-- Groceries need it: a sack of rice must not be offered to somebody on a motorcycle.
ALTER TABLE "products" ADD COLUMN "weightGrams" INTEGER NOT NULL DEFAULT 0;
