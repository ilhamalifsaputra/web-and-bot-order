-- AlterTable
ALTER TABLE "stock_items" ADD COLUMN     "added_by_admin_id" INTEGER,
ADD COLUMN     "credential_fingerprint" TEXT,
ADD COLUMN     "credential_key_version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "dead_reason" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMP(3),
ADD COLUMN     "deleted_by_admin_id" INTEGER,
ADD COLUMN     "identity_fingerprint" TEXT,
ADD COLUMN     "import_batch_id" INTEGER,
ADD COLUMN     "last_check_result" TEXT,
ADD COLUMN     "last_checked_at" TIMESTAMP(3),
ADD COLUMN     "replaces_stock_item_id" INTEGER,
ADD COLUMN     "sold_to_order_id" INTEGER,
ADD COLUMN     "sold_to_order_item_id" INTEGER,
ADD COLUMN     "supplier_ref" TEXT,
ADD COLUMN     "unit_cost" DECIMAL(65,30),
ADD COLUMN     "warranty_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "stock_item_events" (
    "id" SERIAL NOT NULL,
    "stock_item_id" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT,
    "order_id" INTEGER,
    "order_item_id" INTEGER,
    "actor_type" TEXT NOT NULL,
    "actor_admin_id" INTEGER,
    "actor_customer_id" INTEGER,
    "reason_code" TEXT,
    "correlation_id" TEXT,
    "meta" JSONB,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_item_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_import_batches" (
    "id" SERIAL NOT NULL,
    "admin_id" INTEGER,
    "product_id" INTEGER,
    "source_label" TEXT,
    "source_hash" TEXT,
    "rows_submitted" INTEGER NOT NULL,
    "rows_inserted" INTEGER NOT NULL,
    "rows_duplicate" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_item_events_stock_item_id_occurred_at_idx" ON "stock_item_events"("stock_item_id", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_item_events_order_id_idx" ON "stock_item_events"("order_id");

-- CreateIndex
CREATE INDEX "stock_item_events_event_type_occurred_at_idx" ON "stock_item_events"("event_type", "occurred_at");

-- CreateIndex
CREATE INDEX "stock_import_batches_created_at_idx" ON "stock_import_batches"("created_at");

-- CreateIndex
CREATE INDEX "stock_items_identity_fingerprint_idx" ON "stock_items"("identity_fingerprint");

-- CreateIndex
CREATE INDEX "stock_items_credential_fingerprint_idx" ON "stock_items"("credential_fingerprint");

-- CreateIndex
CREATE INDEX "stock_items_sold_to_order_id_idx" ON "stock_items"("sold_to_order_id");

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "stock_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_item_events" ADD CONSTRAINT "stock_item_events_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

