ALTER TABLE "orders" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'PRODUCT';
CREATE INDEX "ix_orders_kind" ON "orders"("kind");
