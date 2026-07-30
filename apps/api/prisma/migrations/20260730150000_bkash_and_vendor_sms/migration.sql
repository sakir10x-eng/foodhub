-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "providerRef" TEXT;
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "smsConfig" TEXT;
-- CreateIndex
CREATE INDEX "payments_providerRef_idx" ON "payments"("providerRef");
