-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_replaces_stock_item_id_fkey" FOREIGN KEY ("replaces_stock_item_id") REFERENCES "stock_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

