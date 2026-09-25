-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN     "active_credential_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ux_stock_items_active_credential_key" ON "stock_items"("active_credential_key");

