-- CreateTable
CREATE TABLE "stock_replacements" (
    "id" SERIAL NOT NULL,
    "order_item_id" INTEGER NOT NULL,
    "original_stock_item_id" INTEGER NOT NULL,
    "replacement_stock_item_id" INTEGER,
    "refund_id" INTEGER,
    "support_ticket_id" INTEGER,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requested_by" INTEGER NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_replacements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_stock_replacements_order_item" ON "stock_replacements"("order_item_id");

-- CreateIndex
CREATE INDEX "ix_stock_replacements_original_stock" ON "stock_replacements"("original_stock_item_id");

-- CreateIndex
CREATE INDEX "ix_stock_replacements_status" ON "stock_replacements"("status");

-- AddForeignKey
ALTER TABLE "stock_replacements" ADD CONSTRAINT "stock_replacements_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_replacements" ADD CONSTRAINT "stock_replacements_original_stock_item_id_fkey" FOREIGN KEY ("original_stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_replacements" ADD CONSTRAINT "stock_replacements_replacement_stock_item_id_fkey" FOREIGN KEY ("replacement_stock_item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_replacements" ADD CONSTRAINT "stock_replacements_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_replacements" ADD CONSTRAINT "stock_replacements_support_ticket_id_fkey" FOREIGN KEY ("support_ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
