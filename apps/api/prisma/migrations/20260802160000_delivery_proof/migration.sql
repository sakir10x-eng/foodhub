-- Proof at the door, and a name for the deliveries that do not happen.
--
-- Additive. `deliveryOtpRequired` defaults to false, so no shop's deliveries start
-- demanding a code they have never told their customers about.

-- ── a delivery that was ridden out and came back ────────────────────────────────────────
-- Reachable only from ON_THE_WAY, and only ever leading to REFUNDED. Kept apart from
-- CANCELLED because the food was cooked and the journey was made: the cost is spent, and a
-- shop that cannot count these cannot see how often nobody answers the door.
ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'RETURNED' BEFORE 'CANCELLED';

-- ── the code at the door ────────────────────────────────────────────────────────────────
ALTER TABLE "orders" ADD COLUMN "deliveryOtp" TEXT;
ALTER TABLE "orders" ADD COLUMN "deliveryOtpAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tenants" ADD COLUMN "deliveryOtpRequired" BOOLEAN NOT NULL DEFAULT false;

-- ── why it did not happen ───────────────────────────────────────────────────────────────
CREATE TYPE "AttemptFailReason" AS ENUM ('NO_ANSWER', 'WRONG_ADDRESS', 'REFUSED', 'NO_CASH', 'OTHER');

CREATE TABLE "delivery_attempts" (
    "id"        UUID NOT NULL,
    "orderId"   UUID NOT NULL,
    "riderId"   UUID NOT NULL,
    "reason"    "AttemptFailReason" NOT NULL,
    "note"      TEXT,
    "lat"       DOUBLE PRECISION,
    "lng"       DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "delivery_attempts_orderId_idx" ON "delivery_attempts"("orderId");
CREATE INDEX "delivery_attempts_riderId_createdAt_idx" ON "delivery_attempts"("riderId", "createdAt");

ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
