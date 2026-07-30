-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_PAID';
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "advanceAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dueOnDelivery" INTEGER NOT NULL DEFAULT 0;
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "advancePercent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "advanceThreshold" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "codEnabled" BOOLEAN NOT NULL DEFAULT true;
-- RenameIndex
ALTER INDEX "order_items_product_idx" RENAME TO "order_items_productId_idx";
