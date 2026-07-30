-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "promotedRank" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "promotedUntil" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "commission_tiers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "minMonthlyGmv" INTEGER NOT NULL,
    "rateBps" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "commission_tiers_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "coupon_funding" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "couponId" UUID NOT NULL,
    "platformShareBps" INTEGER NOT NULL DEFAULT 0,
    "budget" INTEGER NOT NULL DEFAULT 0,
    "budgetSpent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "coupon_funding_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "coupon_funding_couponId_key" ON "coupon_funding"("couponId");
-- AddForeignKey
ALTER TABLE "coupon_funding" ADD CONSTRAINT "coupon_funding_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "coupon_funding" ADD CONSTRAINT "coupon_funding_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
