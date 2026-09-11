-- Binance Internal Transfer (UID-based) payment method.
-- Adds payment-method/ref + payment-message anchor columns to orders, and the
-- idempotency ledger table. Apply in dev with `pnpm prisma db push`; this file
-- is the reproducible delta for production cutover.

-- orders: payment method + auto-confirm note + message anchor for the poller.
ALTER TABLE "orders" ADD COLUMN "payment_method" TEXT NOT NULL DEFAULT 'BINANCE_PAY';
ALTER TABLE "orders" ADD COLUMN "payment_ref" TEXT;
ALTER TABLE "orders" ADD COLUMN "payment_msg_chat_id" BIGINT;
ALTER TABLE "orders" ADD COLUMN "payment_msg_id" INTEGER;
CREATE UNIQUE INDEX "ix_orders_payment_ref" ON "orders"("payment_ref");

-- Idempotency ledger: every Binance tx the poller inspects, recorded once.
-- The UNIQUE binance_tx_id is the concurrency guard (SQLite has no row locks).
CREATE TABLE "processed_binance_tx" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "binance_tx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL,
    "outcome" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ix_processed_binance_tx_txid" ON "processed_binance_tx"("binance_tx_id");
CREATE INDEX "ix_processed_binance_tx_order_id" ON "processed_binance_tx"("order_id");
