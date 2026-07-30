-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "riderId" UUID;
-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "reply" TEXT;
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "autoOpenClose" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "openingHours" JSONB NOT NULL DEFAULT '[]';
-- CreateTable
CREATE TABLE "riders" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "riders_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "riders_token_key" ON "riders"("token");
-- CreateIndex
CREATE INDEX "riders_tenantId_isActive_idx" ON "riders"("tenantId", "isActive");
-- AddForeignKey
ALTER TABLE "riders" ADD CONSTRAINT "riders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "riders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
