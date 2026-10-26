-- AlterTable
ALTER TABLE "denominations" ADD COLUMN     "tiered_pricing_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "bulk_tier_snapshot" JSONB;

-- CreateTable
CREATE TABLE "bulk_pricing_tiers" (
    "id" SERIAL NOT NULL,
    "denomination_id" INTEGER NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "discount_type" TEXT NOT NULL,
    "discount_value" DECIMAL(65,30) NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulk_pricing_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_bulk_pricing_tiers_denomination_id" ON "bulk_pricing_tiers"("denomination_id");

-- CreateIndex
CREATE UNIQUE INDEX "ux_bulk_pricing_tiers_denomination_min_qty" ON "bulk_pricing_tiers"("denomination_id", "min_quantity");

-- AddForeignKey
ALTER TABLE "bulk_pricing_tiers" ADD CONSTRAINT "bulk_pricing_tiers_denomination_id_fkey" FOREIGN KEY ("denomination_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

