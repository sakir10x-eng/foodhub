-- Monotonic write order for the ledger.
--
-- `createdAt` cannot answer "which entry was written last": Postgres now() is
-- transaction-scoped, so every row written inside one transaction shares a timestamp.
-- postOrderDelivered writes three rows per order, and picking the "latest" among them by
-- timestamp is arbitrary — which silently carried the wrong running balance into the
-- next order. A sequence is unambiguous.
--
-- SERIAL backfills existing rows in physical order, which is the correct history here.
ALTER TABLE "ledger_entries" ADD COLUMN "seq" SERIAL NOT NULL;

CREATE UNIQUE INDEX "ledger_entries_seq_key" ON "ledger_entries"("seq");

CREATE INDEX "ledger_entries_tenantId_seq_idx" ON "ledger_entries"("tenantId", "seq");
