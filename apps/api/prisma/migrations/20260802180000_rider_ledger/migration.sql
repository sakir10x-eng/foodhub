-- A rider's money, in two books that must never be added together.
--
-- CASH is the shop's money the rider is carrying. EARNINGS is the rider's own money that
-- we owe them. Merged, "৳500 not yet handed in" and "৳500 of wages owed" look identical —
-- two facts with opposite signs pointing at opposite people.

CREATE TYPE "RiderAccount" AS ENUM ('CASH', 'EARNINGS');
CREATE TYPE "RiderLedgerType" AS ENUM (
  'CASH_COLLECTED', 'CASH_DEPOSITED', 'DELIVERY_FEE', 'ADJUSTMENT', 'PAYOUT'
);

CREATE TABLE "rider_ledger_entries" (
    "id"           UUID NOT NULL,
    -- Monotonic write order. `createdAt` CANNOT be used to find the latest entry:
    -- Postgres now() is transaction-scoped, so rows written together share a timestamp and
    -- "ORDER BY createdAt DESC" picks among them arbitrarily. The vendor ledger learned
    -- this the expensive way; this one is built with the lesson already applied.
    "seq"          SERIAL NOT NULL,
    "riderId"      UUID NOT NULL,
    "tenantId"     UUID NOT NULL,
    "account"      "RiderAccount" NOT NULL,
    "type"         "RiderLedgerType" NOT NULL,
    "amount"       INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "orderId"      UUID,
    "memo"         TEXT NOT NULL DEFAULT '',
    "actor"        TEXT NOT NULL DEFAULT 'system',
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rider_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "rider_ledger_entries_seq_key" ON "rider_ledger_entries"("seq");

-- One entry of each kind per order. This is what makes a replayed DELIVERED harmless:
-- the second write collides instead of paying the rider twice. Deposits and payouts carry
-- no order, and Postgres permits many NULLs in a unique index.
CREATE UNIQUE INDEX "rider_ledger_entries_orderId_type_key"
  ON "rider_ledger_entries"("orderId", "type");

CREATE INDEX "rider_ledger_entries_riderId_account_seq_idx"
  ON "rider_ledger_entries"("riderId", "account", "seq");
CREATE INDEX "rider_ledger_entries_tenantId_createdAt_idx"
  ON "rider_ledger_entries"("tenantId", "createdAt");

ALTER TABLE "rider_ledger_entries" ADD CONSTRAINT "rider_ledger_entries_riderId_fkey"
  FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rider_ledger_entries" ADD CONSTRAINT "rider_ledger_entries_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "rider_ledger_entries" ADD CONSTRAINT "rider_ledger_entries_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the rider is paid, and how much of the shop's cash they may hold before new
-- cash-on-delivery work stops being offered. ৳30 and ৳5,000.
ALTER TABLE "tenants" ADD COLUMN "riderFeePerDelivery" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "tenants" ADD COLUMN "riderCashLimit" INTEGER NOT NULL DEFAULT 500000;
