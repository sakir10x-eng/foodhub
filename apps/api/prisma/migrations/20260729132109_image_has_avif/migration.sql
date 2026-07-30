-- DropIndex
DROP INDEX "products_description_trgm_idx";

-- DropIndex
DROP INDEX "products_name_trgm_idx";

-- DropIndex
DROP INDEX "tenants_marketplace_feed_idx";

-- DropIndex
DROP INDEX "tenants_name_trgm_idx";

-- AlterTable
ALTER TABLE "images" ADD COLUMN     "hasAvif" BOOLEAN NOT NULL DEFAULT false;
