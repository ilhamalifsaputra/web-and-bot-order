-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_orders" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_code" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "subtotal_amount" DECIMAL NOT NULL,
    "discount_amount" DECIMAL NOT NULL DEFAULT 0,
    "unique_cents" DECIMAL NOT NULL DEFAULT 0,
    "total_amount" DECIMAL NOT NULL,
    "voucher_id" INTEGER,
    "wallet_used" DECIMAL NOT NULL DEFAULT 0,
    "bulk_discount_amount" DECIMAL NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "fx_rate" DECIMAL,
    "payment_method" TEXT NOT NULL DEFAULT 'BINANCE_PAY',
    "payment_ref" TEXT,
    "payment_msg_chat_id" BIGINT,
    "payment_msg_id" INTEGER,
    "payment_proof_file_id" TEXT,
    "binance_txid" TEXT,
    "bybit_txid" TEXT,
    "admin_note" TEXT,
    "rejection_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME,
    "paid_at" DATETIME,
    "delivered_at" DATETIME,
    "customer_data" TEXT,
    "delivered_content" TEXT,
    "network" TEXT,
    "confirmations" INTEGER,
    "required_confirmations" INTEGER,
    "first_detected_at" DATETIME,
    "kind" TEXT NOT NULL DEFAULT 'PRODUCT',
    "confirmed_at" DATETIME,
    "tracking_stale_at" DATETIME,
    "digiflazz_dispatched_at" DATETIME,
    "digiflazz_status" TEXT,
    "digiflazz_attempts" INTEGER NOT NULL DEFAULT 0,
    "digiflazz_next_recheck_at" DATETIME,
    "digiflazz_failure_detail" TEXT,
    CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "orders_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_orders" ("admin_note", "binance_txid", "bulk_discount_amount", "bybit_txid", "confirmations", "confirmed_at", "created_at", "currency", "customer_data", "delivered_at", "delivered_content", "digiflazz_dispatched_at", "discount_amount", "expires_at", "first_detected_at", "fx_rate", "id", "kind", "network", "order_code", "paid_at", "payment_method", "payment_msg_chat_id", "payment_msg_id", "payment_proof_file_id", "payment_ref", "rejection_reason", "required_confirmations", "status", "subtotal_amount", "total_amount", "tracking_stale_at", "unique_cents", "user_id", "voucher_id", "wallet_used") SELECT "orders"."admin_note", "orders"."binance_txid", "orders"."bulk_discount_amount", "orders"."bybit_txid", "orders"."confirmations", "orders"."confirmed_at", "orders"."created_at", "orders"."currency", "orders"."customer_data", "orders"."delivered_at", "orders"."delivered_content", "orders"."digiflazz_dispatched_at", "orders"."discount_amount", "orders"."expires_at", "orders"."first_detected_at", "orders"."fx_rate", "orders"."id", "orders"."kind", "orders"."network", "orders"."order_code", "orders"."paid_at", "orders"."payment_method", "orders"."payment_msg_chat_id", "orders"."payment_msg_id", "orders"."payment_proof_file_id", "orders"."payment_ref", "orders"."rejection_reason", "orders"."required_confirmations", "orders"."status", "orders"."subtotal_amount", "orders"."total_amount", "orders"."tracking_stale_at", "orders"."unique_cents", "orders"."user_id", "orders"."voucher_id", "orders"."wallet_used" FROM "orders";
DROP TABLE "orders";
ALTER TABLE "new_orders" RENAME TO "orders";
CREATE UNIQUE INDEX "ix_orders_order_code" ON "orders"("order_code");
CREATE UNIQUE INDEX "ix_orders_payment_ref" ON "orders"("payment_ref");
CREATE INDEX "ix_orders_user_id" ON "orders"("user_id");
CREATE INDEX "ix_orders_status" ON "orders"("status");
CREATE INDEX "ix_orders_binance_txid" ON "orders"("binance_txid");
CREATE INDEX "ix_orders_bybit_txid" ON "orders"("bybit_txid");
CREATE INDEX "ix_orders_status_created" ON "orders"("status", "created_at");
CREATE INDEX "ix_orders_status_delivered" ON "orders"("status", "delivered_at");
CREATE INDEX "ix_orders_kind" ON "orders"("kind");
CREATE INDEX "ix_orders_digiflazz_recheck" ON "orders"("digiflazz_status", "digiflazz_next_recheck_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
