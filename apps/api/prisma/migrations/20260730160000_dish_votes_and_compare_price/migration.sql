-- AlterTable
ALTER TABLE "products" ADD COLUMN     "compareAtPrice" INTEGER,
ADD COLUMN     "thumbsTotal" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "thumbsUp" INTEGER NOT NULL DEFAULT 0;
-- CreateTable
CREATE TABLE "product_votes" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "up" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "product_votes_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "product_votes_orderId_productId_key" ON "product_votes"("orderId", "productId");
-- CreateIndex
CREATE INDEX "product_votes_tenantId_productId_idx" ON "product_votes"("tenantId", "productId");
-- AddForeignKey
ALTER TABLE "product_votes" ADD CONSTRAINT "product_votes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "product_votes" ADD CONSTRAINT "product_votes_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "product_votes" ADD CONSTRAINT "product_votes_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
