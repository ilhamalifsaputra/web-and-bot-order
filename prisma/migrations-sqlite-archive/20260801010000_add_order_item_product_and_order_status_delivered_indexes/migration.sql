-- Task 41 (M-32, backend audit 2026-07-31): index the filter/join columns
-- used by the revenue/flash-sale queries added earlier in this batch —
-- topProductsByMargin, profitSummarySince, and flashSalePerformance filter
-- and join on exactly order_items.product_id and orders.(status,
-- delivered_at). Without these, both become full scans on order_items (the
-- fastest-growing table) and orders, holding read locks that queue behind
-- concurrent checkout writes on this single-writer SQLite deployment.
--
-- Pasted verbatim from `prisma migrate diff --from-migrations
-- ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script`
-- after adding the two `@@index` lines to schema.prisma (OrderItem.productId,
-- Order.[status, deliveredAt]) — both plain `CREATE INDEX` statements, no
-- table rebuild, no DROP TABLE, so no cascade-delete exposure on either
-- table's FK children (order_items and orders both have child tables:
-- stock_items, cart_items, reviews, order_status_history, etc.).
--
-- Verified: re-running the same `prisma migrate diff ... --exit-code`
-- command after this file was added reports "No difference detected."
-- (exit 0).

-- CreateIndex
CREATE INDEX "ix_order_items_product_id" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "ix_orders_status_delivered" ON "orders"("status", "delivered_at");
