-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "ga4MeasurementId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "metaPixelId" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "refereeReward" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "referralEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "referralMinSpend" INTEGER NOT NULL DEFAULT 30000,
ADD COLUMN     "referrerReward" INTEGER NOT NULL DEFAULT 5000,
ADD COLUMN     "tiktokPixelId" TEXT NOT NULL DEFAULT '';
-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "referrerPhone" TEXT NOT NULL,
    "refereePhone" TEXT,
    "orderId" UUID,
    "rewardedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "referrals_tenantId_referrerPhone_idx" ON "referrals"("tenantId", "referrerPhone");
-- CreateIndex
CREATE INDEX "referrals_refereePhone_idx" ON "referrals"("refereePhone");
-- CreateIndex
CREATE UNIQUE INDEX "referrals_tenantId_code_key" ON "referrals"("tenantId", "code");
-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
