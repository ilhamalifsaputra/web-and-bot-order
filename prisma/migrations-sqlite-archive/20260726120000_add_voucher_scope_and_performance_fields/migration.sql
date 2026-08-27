-- Add voucher scope and performance fields
ALTER TABLE "vouchers" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'ALL';
ALTER TABLE "vouchers" ADD COLUMN "max_discount" DECIMAL;
ALTER TABLE "vouchers" ADD COLUMN "start_at" DATETIME;

-- Create voucher_products join table for scoped voucher applicability
CREATE TABLE "voucher_products" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "voucher_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    CONSTRAINT "voucher_products_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "voucher_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- Create unique constraint on (voucher_id, product_id)
CREATE UNIQUE INDEX "ix_voucher_products_voucher_product" ON "voucher_products"("voucher_id", "product_id");

-- Create index on product_id
CREATE INDEX "ix_voucher_products_product_id" ON "voucher_products"("product_id");
