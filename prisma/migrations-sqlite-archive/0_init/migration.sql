-- CreateTable
CREATE TABLE "users" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegram_id" BIGINT NOT NULL,
    "username" TEXT,
    "full_name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "language" TEXT NOT NULL DEFAULT 'EN',
    "wallet_balance" DECIMAL NOT NULL DEFAULT 0,
    "referral_code" TEXT NOT NULL,
    "referred_by_id" INTEGER,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banned_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" DATETIME,
    CONSTRAINT "users_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "categories" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "emoji" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true
);

-- CreateTable
CREATE TABLE "products" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_file_id" TEXT,
    "type" TEXT NOT NULL,
    "duration_label" TEXT NOT NULL,
    "price" DECIMAL NOT NULL,
    "reseller_price" DECIMAL,
    "warranty_days" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "order_id" INTEGER,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" DATETIME,
    "sold_at" DATETIME,
    "note" TEXT,
    CONSTRAINT "stock_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "stock_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "orders" (
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
    "payment_proof_file_id" TEXT,
    "binance_txid" TEXT,
    "admin_note" TEXT,
    "rejection_reason" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" DATETIME,
    "paid_at" DATETIME,
    "delivered_at" DATETIME,
    CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "orders_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL NOT NULL,
    "warranty_days_snapshot" INTEGER NOT NULL,
    CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL NOT NULL,
    "usage_limit" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "min_purchase" DECIMAL NOT NULL DEFAULT 0,
    "expires_at" DATETIME,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "referrer_id" INTEGER NOT NULL,
    "referee_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "commission" DECIMAL NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referrals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "referrals_referee_id_fkey" FOREIGN KEY ("referee_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "photo_file_ids" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "admin_reply" TEXT,
    "admin_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replied_at" DATETIME,
    CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "support_tickets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ticket_id" INTEGER NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_id" INTEGER,
    "content" TEXT NOT NULL,
    "photo_file_ids" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "ticket_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "restock_subscriptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restock_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "restock_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "added_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cart_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "bulk_pricing" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "discount_percent" DECIMAL NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bulk_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "admin_id" INTEGER,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" INTEGER,
    "details" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "event" TEXT NOT NULL,
    "payload_json" TEXT NOT NULL,
    "order_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" DATETIME,
    CONSTRAINT "notification_outbox_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);

-- CreateTable
CREATE TABLE "alembic_version" (
    "version_num" TEXT NOT NULL PRIMARY KEY
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_telegram_id" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_referral_code" ON "users"("referral_code");

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_categories_1" ON "categories"("name");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "ix_products_category_id" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "ix_stock_items_status" ON "stock_items"("status");

-- CreateIndex
CREATE INDEX "ix_stock_items_product_id" ON "stock_items"("product_id");

-- CreateIndex
CREATE INDEX "ix_stock_product_status" ON "stock_items"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ix_orders_order_code" ON "orders"("order_code");

-- CreateIndex
CREATE INDEX "ix_orders_user_id" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "ix_orders_status" ON "orders"("status");

-- CreateIndex
CREATE INDEX "ix_orders_binance_txid" ON "orders"("binance_txid");

-- CreateIndex
CREATE INDEX "ix_orders_status_created" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_order_items_order_id" ON "order_items"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_vouchers_code" ON "vouchers"("code");

-- CreateIndex
CREATE INDEX "ix_reviews_product_id" ON "reviews"("product_id");

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_reviews_1" ON "reviews"("user_id", "order_id");
Pragma writable_schema=0;

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_referrals_1" ON "referrals"("referee_id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "ix_referrals_referrer_id" ON "referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "ix_support_tickets_user_id" ON "support_tickets"("user_id");

-- CreateIndex
CREATE INDEX "ix_ticket_messages_ticket_id" ON "ticket_messages"("ticket_id");

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_restock_subscriptions_1" ON "restock_subscriptions"("user_id", "product_id");
Pragma writable_schema=0;

-- CreateIndex
CREATE INDEX "ix_cart_items_user_id" ON "cart_items"("user_id");

-- CreateIndex
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_cart_items_1" ON "cart_items"("user_id", "product_id");
Pragma writable_schema=0;

-- CreateIndex
CREATE UNIQUE INDEX "ix_bulk_pricing_product_id" ON "bulk_pricing"("product_id");

-- CreateIndex
CREATE INDEX "ix_audit_logs_created_at" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "ix_notif_status_created" ON "notification_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_outbox_order_id" ON "notification_outbox"("order_id");

-- CreateIndex
CREATE INDEX "ix_notification_outbox_status" ON "notification_outbox"("status");

-- CreateIndex
CREATE INDEX "ix_notification_outbox_created_at" ON "notification_outbox"("created_at");

