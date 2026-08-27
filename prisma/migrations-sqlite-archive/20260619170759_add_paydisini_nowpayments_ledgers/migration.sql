/*
  Warnings:

  - You are about to drop the column `duration_label` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `price` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `reseller_price` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `products` table. All the data in the column will be lost.
  - You are about to drop the column `warranty_days` on the `products` table. All the data in the column will be lost.
  - Added the required column `slug` to the `categories` table without a default value. This is not possible if the table is not empty.
  - Added the required column `slug` to the `products` table without a default value. This is not possible if the table is not empty.

*/
-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" DATETIME NOT NULL,
    "used_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "denominations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "image_file_id" TEXT,
    "web_image_url" TEXT,
    "type" TEXT NOT NULL,
    "duration_label" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "cost_price" DECIMAL,
    "reseller_price" DECIMAL,
    "auto_delivery_source" TEXT,
    "warranty_days" INTEGER NOT NULL DEFAULT 30,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "denominations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "processed_bybit_tx" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "bybit_tx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL,
    "outcome" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "processed_tokopay_tx" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "trx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL,
    "outcome" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "processed_paydisini_tx" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "trx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL,
    "outcome" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "processed_nowpayments_tx" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "trx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL,
    "outcome" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_bulk_pricing" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "discount_percent" DECIMAL NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bulk_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_bulk_pricing" ("created_at", "discount_percent", "id", "is_active", "min_quantity", "product_id") SELECT "created_at", "discount_percent", "id", "is_active", "min_quantity", "product_id" FROM "bulk_pricing";
DROP TABLE "bulk_pricing";
ALTER TABLE "new_bulk_pricing" RENAME TO "bulk_pricing";
CREATE UNIQUE INDEX "ix_bulk_pricing_product_id" ON "bulk_pricing"("product_id");
CREATE TABLE "new_cart_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cart_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_cart_items" ("added_at", "id", "product_id", "quantity", "user_id") SELECT "added_at", "id", "product_id", "quantity", "user_id" FROM "cart_items";
DROP TABLE "cart_items";
ALTER TABLE "new_cart_items" RENAME TO "cart_items";
CREATE INDEX "ix_cart_items_user_id" ON "cart_items"("user_id");
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_cart_items_1" ON "cart_items"("user_id", "product_id");
Pragma writable_schema=0;
CREATE TABLE "new_categories" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "image" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true
);
INSERT INTO "new_categories" ("emoji", "id", "is_active", "name", "sort_order") SELECT "emoji", "id", "is_active", "name", "sort_order" FROM "categories";
DROP TABLE "categories";
ALTER TABLE "new_categories" RENAME TO "categories";
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_categories_1" ON "categories"("name");
Pragma writable_schema=0;
CREATE UNIQUE INDEX "ix_categories_slug" ON "categories"("slug");
CREATE TABLE "new_order_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL NOT NULL,
    "warranty_days_snapshot" INTEGER NOT NULL,
    CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_order_items" ("id", "order_id", "product_id", "quantity", "stock_item_id", "unit_price", "warranty_days_snapshot") SELECT "id", "order_id", "product_id", "quantity", "stock_item_id", "unit_price", "warranty_days_snapshot" FROM "order_items";
DROP TABLE "order_items";
ALTER TABLE "new_order_items" RENAME TO "order_items";
CREATE INDEX "ix_order_items_order_id" ON "order_items"("order_id");
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
    CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "orders_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_orders" ("admin_note", "binance_txid", "bulk_discount_amount", "created_at", "delivered_at", "discount_amount", "expires_at", "id", "order_code", "paid_at", "payment_method", "payment_msg_chat_id", "payment_msg_id", "payment_proof_file_id", "payment_ref", "rejection_reason", "status", "subtotal_amount", "total_amount", "unique_cents", "user_id", "voucher_id", "wallet_used") SELECT "admin_note", "binance_txid", "bulk_discount_amount", "created_at", "delivered_at", "discount_amount", "expires_at", "id", "order_code", "paid_at", "payment_method", "payment_msg_chat_id", "payment_msg_id", "payment_proof_file_id", "payment_ref", "rejection_reason", "status", "subtotal_amount", "total_amount", "unique_cents", "user_id", "voucher_id", "wallet_used" FROM "orders";
DROP TABLE "orders";
ALTER TABLE "new_orders" RENAME TO "orders";
CREATE UNIQUE INDEX "ix_orders_order_code" ON "orders"("order_code");
CREATE UNIQUE INDEX "ix_orders_payment_ref" ON "orders"("payment_ref");
CREATE INDEX "ix_orders_user_id" ON "orders"("user_id");
CREATE INDEX "ix_orders_status" ON "orders"("status");
CREATE INDEX "ix_orders_binance_txid" ON "orders"("binance_txid");
CREATE INDEX "ix_orders_bybit_txid" ON "orders"("bybit_txid");
CREATE INDEX "ix_orders_status_created" ON "orders"("status", "created_at");
CREATE TABLE "new_products" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "web_image_url" TEXT,
    "image_file_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
INSERT INTO "new_products" ("category_id", "created_at", "description", "id", "image_file_id", "is_active", "name") SELECT "category_id", "created_at", "description", "id", "image_file_id", "is_active", "name" FROM "products";
DROP TABLE "products";
ALTER TABLE "new_products" RENAME TO "products";
CREATE UNIQUE INDEX "ix_products_slug" ON "products"("slug");
CREATE INDEX "ix_products_category_id" ON "products"("category_id");
CREATE TABLE "new_restock_subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restock_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "restock_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_restock_subscriptions" ("created_at", "id", "product_id", "user_id") SELECT "created_at", "id", "product_id", "user_id" FROM "restock_subscriptions";
DROP TABLE "restock_subscriptions";
ALTER TABLE "new_restock_subscriptions" RENAME TO "restock_subscriptions";
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_restock_subscriptions_1" ON "restock_subscriptions"("user_id", "product_id");
Pragma writable_schema=0;
CREATE TABLE "new_reviews" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_reviews" ("comment", "created_at", "hidden", "id", "order_id", "product_id", "rating", "user_id") SELECT "comment", "created_at", "hidden", "id", "order_id", "product_id", "rating", "user_id" FROM "reviews";
DROP TABLE "reviews";
ALTER TABLE "new_reviews" RENAME TO "reviews";
CREATE INDEX "ix_reviews_product_id" ON "reviews"("product_id");
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_reviews_1" ON "reviews"("user_id", "order_id");
Pragma writable_schema=0;
CREATE TABLE "new_stock_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "order_id" INTEGER,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" DATETIME,
    "sold_at" DATETIME,
    "note" TEXT,
    CONSTRAINT "stock_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "stock_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_stock_items" ("added_at", "credentials", "id", "note", "order_id", "product_id", "reserved_at", "sold_at", "status") SELECT "added_at", "credentials", "id", "note", "order_id", "product_id", "reserved_at", "sold_at", "status" FROM "stock_items";
DROP TABLE "stock_items";
ALTER TABLE "new_stock_items" RENAME TO "stock_items";
CREATE INDEX "ix_stock_items_status" ON "stock_items"("status");
CREATE INDEX "ix_stock_items_product_id" ON "stock_items"("product_id");
CREATE INDEX "ix_stock_product_status" ON "stock_items"("product_id", "status");
CREATE TABLE "new_users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegram_id" BIGINT,
    "username" TEXT,
    "full_name" TEXT,
    "login_username" TEXT,
    "email" TEXT,
    "password_hash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "language" TEXT NOT NULL DEFAULT 'EN',
    "wallet_balance" DECIMAL NOT NULL DEFAULT 0,
    "wallet_balance_usdt" DECIMAL NOT NULL DEFAULT 0,
    "referral_code" TEXT NOT NULL,
    "referred_by_id" INTEGER,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banned_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME,
    CONSTRAINT "users_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_users" ("banned", "banned_reason", "created_at", "full_name", "id", "language", "last_seen_at", "referral_code", "referred_by_id", "role", "telegram_id", "username", "wallet_balance") SELECT "banned", "banned_reason", "created_at", "full_name", "id", "language", "last_seen_at", "referral_code", "referred_by_id", "role", "telegram_id", "username", "wallet_balance" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "ix_users_telegram_id" ON "users"("telegram_id");
CREATE UNIQUE INDEX "ix_users_login_username" ON "users"("login_username");
CREATE UNIQUE INDEX "ix_users_email" ON "users"("email");
CREATE UNIQUE INDEX "ix_users_referral_code" ON "users"("referral_code");
CREATE TABLE "new_wallet_transactions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "delta" DECIMAL NOT NULL,
    "balance_after" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "admin_id" INTEGER,
    "order_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_wallet_transactions" ("admin_id", "balance_after", "created_at", "delta", "id", "note", "order_id", "reason", "user_id") SELECT "admin_id", "balance_after", "created_at", "delta", "id", "note", "order_id", "reason", "user_id" FROM "wallet_transactions";
DROP TABLE "wallet_transactions";
ALTER TABLE "new_wallet_transactions" RENAME TO "wallet_transactions";
CREATE INDEX "ix_wallet_transactions_user_id" ON "wallet_transactions"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "ix_password_reset_tokens_hash" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "ix_password_reset_tokens_user_id" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_denominations_slug" ON "denominations"("slug");

-- CreateIndex
CREATE INDEX "ix_denominations_product_id" ON "denominations"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_processed_bybit_tx_txid" ON "processed_bybit_tx"("bybit_tx_id");

-- CreateIndex
CREATE INDEX "ix_processed_bybit_tx_order_id" ON "processed_bybit_tx"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_processed_tokopay_tx_trxid" ON "processed_tokopay_tx"("trx_id");

-- CreateIndex
CREATE INDEX "ix_processed_tokopay_tx_order_id" ON "processed_tokopay_tx"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_processed_paydisini_tx_trxid" ON "processed_paydisini_tx"("trx_id");

-- CreateIndex
CREATE INDEX "ix_processed_paydisini_tx_order_id" ON "processed_paydisini_tx"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_processed_nowpayments_tx_trxid" ON "processed_nowpayments_tx"("trx_id");

-- CreateIndex
CREATE INDEX "ix_processed_nowpayments_tx_order_id" ON "processed_nowpayments_tx"("order_id");
