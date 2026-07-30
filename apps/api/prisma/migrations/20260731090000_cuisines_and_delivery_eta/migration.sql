-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "cuisines" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "deliveryMinutes" INTEGER NOT NULL DEFAULT 20;

-- CreateIndex
-- GIN, not btree: the marketplace filter asks "does this vendor's array contain
-- 'Biryani'", which btree cannot answer without a scan.
CREATE INDEX "tenants_cuisines_idx" ON "tenants" USING GIN ("cuisines");
