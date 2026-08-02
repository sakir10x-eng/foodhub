-- One rider, several shops, several houses: the run.
--
-- Additive throughout. An order with no trip stop behaves exactly as it did — including
-- the old rider-visibility rule, which is what keeps every delivery placed before today
-- correct rather than retroactively hidden.

CREATE TYPE "TripStatus" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "StopKind" AS ENUM ('PICKUP', 'DROP');

CREATE TABLE "trips" (
    "id"          UUID NOT NULL,
    "riderId"     UUID NOT NULL,
    "status"      "TripStatus" NOT NULL DEFAULT 'PLANNED',
    -- The seq of the stop being travelled to. Written by advanceTrip() and nothing else.
    "activeSeq"   INTEGER NOT NULL DEFAULT 0,
    "startedAt"   TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "trips_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trips_riderId_status_idx" ON "trips"("riderId", "status");

CREATE TABLE "trip_stops" (
    "id"          UUID NOT NULL,
    "tripId"      UUID NOT NULL,
    "seq"         INTEGER NOT NULL,
    "kind"        "StopKind" NOT NULL,
    "orderId"     UUID NOT NULL,
    "tenantId"    UUID NOT NULL,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id")
);

-- Two stops of the same kind for one order on one trip is a bug, not a use case.
CREATE UNIQUE INDEX "trip_stops_tripId_seq_key" ON "trip_stops"("tripId", "seq");
CREATE UNIQUE INDEX "trip_stops_tripId_orderId_kind_key" ON "trip_stops"("tripId", "orderId", "kind");
CREATE INDEX "trip_stops_orderId_idx" ON "trip_stops"("orderId");

ALTER TABLE "trips" ADD CONSTRAINT "trips_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_tripId_fkey"
  FOREIGN KEY ("tripId") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "trip_stops" ADD CONSTRAINT "trip_stops_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- When the parcel actually left the counter. Not a status — see the schema comment.
ALTER TABLE "orders" ADD COLUMN "pickedUpAt" TIMESTAMP(3);
