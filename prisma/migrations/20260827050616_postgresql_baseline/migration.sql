-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "telegram_id" BIGINT,
    "username" TEXT,
    "full_name" TEXT,
    "login_username" TEXT,
    "email" TEXT,
    "password_hash" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "language" TEXT NOT NULL DEFAULT 'EN',
    "wallet_balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "wallet_balance_usdt" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "referral_code" TEXT NOT NULL,
    "referred_by_id" INTEGER,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banned_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3),
    "is_guest" BOOLEAN NOT NULL DEFAULT false,
    "guest_email" TEXT,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "delta" DECIMAL(65,30) NOT NULL,
    "balance_after" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "admin_id" INTEGER,
    "order_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "image" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "group" TEXT,
    "checkout_flow" TEXT NOT NULL DEFAULT 'catalog',

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "nickname_supported" BOOLEAN NOT NULL DEFAULT true,
    "requires_zone" BOOLEAN NOT NULL DEFAULT false,
    "requires_server" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_game_mappings" (
    "id" SERIAL NOT NULL,
    "game_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_game_code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_game_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" SERIAL NOT NULL,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "what_you_get" TEXT,
    "terms" TEXT,
    "warranty_note" TEXT,
    "web_image_url" TEXT,
    "image_file_id" TEXT,
    "digiflazz_brand" TEXT,
    "game_variant" TEXT,
    "game_variant_emoji" TEXT,
    "game_region" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "game_id" INTEGER,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "denominations" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "image_file_id" TEXT,
    "web_image_url" TEXT,
    "type" TEXT NOT NULL,
    "duration_label" TEXT NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,
    "cost_price" DECIMAL(65,30),
    "reseller_price" DECIMAL(65,30),
    "auto_delivery_source" TEXT,
    "supplier_sku" TEXT,
    "nickname_check_game_code" TEXT,
    "region_warning" TEXT,
    "expected_region_code" TEXT,
    "price_overridden" BOOLEAN NOT NULL DEFAULT false,
    "qty_value" INTEGER,
    "qty_unit" TEXT,
    "warranty_days" INTEGER NOT NULL DEFAULT 30,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "broadcast_on_restock" BOOLEAN NOT NULL DEFAULT false,
    "delivery_type" TEXT NOT NULL DEFAULT 'auto',
    "additional_fields" TEXT,
    "flash_discount_percent" DECIMAL(65,30),
    "flash_starts_at" TIMESTAMP(3),
    "flash_ends_at" TIMESTAMP(3),
    "flash_announced_at" TIMESTAMP(3),

    CONSTRAINT "denominations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_provider_mappings" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_sku" TEXT NOT NULL,
    "provider_cost" DECIMAL(65,30),
    "cost_synced_at" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_provider_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_items" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "credentials" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "order_id" INTEGER,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" TIMESTAMP(3),
    "sold_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" SERIAL NOT NULL,
    "order_code" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "subtotal_amount" DECIMAL(65,30) NOT NULL,
    "discount_amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "unique_cents" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(65,30) NOT NULL,
    "voucher_id" INTEGER,
    "wallet_used" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "bulk_discount_amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "fx_rate" DECIMAL(65,30),
    "payment_method" TEXT NOT NULL DEFAULT 'BINANCE_PAY',
    "payment_ref" TEXT,
    "payment_msg_chat_id" BIGINT,
    "payment_msg_id" INTEGER,
    "payment_proof_file_id" TEXT,
    "binance_txid" TEXT,
    "bybit_txid" TEXT,
    "admin_note" TEXT,
    "rejection_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "customer_data" TEXT,
    "delivered_content" TEXT,
    "network" TEXT,
    "confirmations" INTEGER,
    "required_confirmations" INTEGER,
    "first_detected_at" TIMESTAMP(3),
    "kind" TEXT NOT NULL DEFAULT 'PRODUCT',
    "confirmed_at" TIMESTAMP(3),
    "tracking_stale_at" TIMESTAMP(3),
    "digiflazz_dispatched_at" TIMESTAMP(3),
    "digiflazz_status" TEXT,
    "digiflazz_attempts" INTEGER NOT NULL DEFAULT 0,
    "digiflazz_next_recheck_at" TIMESTAMP(3),
    "digiflazz_failure_detail" TEXT,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" TEXT,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(65,30) NOT NULL,
    "warranty_days_snapshot" INTEGER NOT NULL,
    "delivery_type_snapshot" TEXT,
    "status" TEXT,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "external_reference" TEXT,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_items" (
    "id" SERIAL NOT NULL,
    "refund_id" INTEGER NOT NULL,
    "order_item_id" INTEGER NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_tasks" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "order_id" INTEGER,
    "order_item_id" INTEGER,
    "refund_id" INTEGER,
    "assigned_to" INTEGER,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "due_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "usage_limit" INTEGER,
    "used_count" INTEGER NOT NULL DEFAULT 0,
    "min_purchase" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "max_discount" DECIMAL(65,30),
    "start_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_redemptions" (
    "id" SERIAL NOT NULL,
    "voucher_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_products" (
    "id" SERIAL NOT NULL,
    "voucher_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,

    CONSTRAINT "voucher_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REPLY',
    "source" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "admin_reply" TEXT,
    "replied_at" TIMESTAMP(3),
    "replied_by_admin_id" INTEGER,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referrals" (
    "id" SERIAL NOT NULL,
    "referrer_id" INTEGER NOT NULL,
    "referee_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "commission" DECIMAL(65,30) NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "photo_file_ids" TEXT,
    "attachment_urls" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT,
    "admin_reply" TEXT,
    "admin_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replied_at" TIMESTAMP(3),
    "first_response_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "order_id" INTEGER,
    "last_status_change_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_messages" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "sender_type" TEXT NOT NULL,
    "sender_id" INTEGER,
    "content" TEXT NOT NULL,
    "photo_file_ids" TEXT,
    "attachment_urls" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restock_subscriptions" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restock_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_pricing" (
    "id" SERIAL NOT NULL,
    "product_id" INTEGER NOT NULL,
    "min_quantity" INTEGER NOT NULL,
    "discount_percent" DECIMAL(65,30) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bulk_pricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" SERIAL NOT NULL,
    "admin_id" INTEGER,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" INTEGER,
    "details" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" SERIAL NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'TELEGRAM',
    "payload_json" TEXT NOT NULL,
    "order_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "next_retry_at" TIMESTAMP(3),
    "dedupe_key" TEXT,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" SERIAL NOT NULL,
    "message" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduled_at" TIMESTAMP(3),
    "created_by_id" INTEGER,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "web_image_url" TEXT,
    "image_file_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_binance_tx" (
    "id" SERIAL NOT NULL,
    "binance_tx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL(65,30),
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_binance_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_bybit_tx" (
    "id" SERIAL NOT NULL,
    "bybit_tx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL(65,30),
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_bybit_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_tokopay_tx" (
    "id" SERIAL NOT NULL,
    "trx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL(65,30),
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_tokopay_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_paydisini_tx" (
    "id" SERIAL NOT NULL,
    "trx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL(65,30),
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_paydisini_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_nowpayments_tx" (
    "id" SERIAL NOT NULL,
    "trx_id" TEXT NOT NULL,
    "order_id" INTEGER,
    "amount" DECIMAL(65,30),
    "outcome" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_nowpayments_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_body" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_telegram_id" ON "users"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_login_username" ON "users"("login_username");

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_email" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ix_users_referral_code" ON "users"("referral_code");

-- CreateIndex
CREATE INDEX "ix_users_role_created_at" ON "users"("role", "created_at");

-- CreateIndex
CREATE INDEX "ix_users_last_seen_at" ON "users"("last_seen_at");

-- CreateIndex
CREATE INDEX "ix_wallet_transactions_user_id" ON "wallet_transactions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_wallet_transactions_order_id_reason" ON "wallet_transactions"("order_id", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "ix_password_reset_tokens_hash" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "ix_password_reset_tokens_user_id" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_categories_1" ON "categories"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ix_categories_slug" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ix_games_slug" ON "games"("slug");

-- CreateIndex
CREATE INDEX "ix_provider_game_mappings_game_priority" ON "provider_game_mappings"("game_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ix_provider_game_mappings_game_provider" ON "provider_game_mappings"("game_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ix_products_slug" ON "products"("slug");

-- CreateIndex
CREATE INDEX "ix_products_category_id" ON "products"("category_id");

-- CreateIndex
CREATE INDEX "ix_products_game_id" ON "products"("game_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_denominations_slug" ON "denominations"("slug");

-- CreateIndex
CREATE INDEX "ix_denominations_product_id" ON "denominations"("product_id");

-- CreateIndex
CREATE INDEX "ix_denominations_flash_ends_at" ON "denominations"("flash_ends_at");

-- CreateIndex
CREATE INDEX "ix_product_provider_mappings_product_priority" ON "product_provider_mappings"("product_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ix_product_provider_mappings_product_provider" ON "product_provider_mappings"("product_id", "provider");

-- CreateIndex
CREATE INDEX "ix_stock_items_status" ON "stock_items"("status");

-- CreateIndex
CREATE INDEX "ix_stock_items_product_id" ON "stock_items"("product_id");

-- CreateIndex
CREATE INDEX "ix_stock_product_status" ON "stock_items"("product_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ix_orders_order_code" ON "orders"("order_code");

-- CreateIndex
CREATE UNIQUE INDEX "ix_orders_payment_ref" ON "orders"("payment_ref");

-- CreateIndex
CREATE INDEX "ix_orders_user_id" ON "orders"("user_id");

-- CreateIndex
CREATE INDEX "ix_orders_status" ON "orders"("status");

-- CreateIndex
CREATE INDEX "ix_orders_binance_txid" ON "orders"("binance_txid");

-- CreateIndex
CREATE INDEX "ix_orders_bybit_txid" ON "orders"("bybit_txid");

-- CreateIndex
CREATE INDEX "ix_orders_status_created" ON "orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_orders_status_delivered" ON "orders"("status", "delivered_at");

-- CreateIndex
CREATE INDEX "ix_orders_kind" ON "orders"("kind");

-- CreateIndex
CREATE INDEX "ix_orders_digiflazz_recheck" ON "orders"("digiflazz_status", "digiflazz_next_recheck_at");

-- CreateIndex
CREATE INDEX "ix_order_status_history_order_occurred" ON "order_status_history"("order_id", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_order_items_order_id" ON "order_items"("order_id");

-- CreateIndex
CREATE INDEX "ix_order_items_product_id" ON "order_items"("product_id");

-- CreateIndex
CREATE INDEX "ix_refunds_order_id" ON "refunds"("order_id");

-- CreateIndex
CREATE INDEX "ix_refunds_status" ON "refunds"("status");

-- CreateIndex
CREATE INDEX "ix_refund_items_refund_id" ON "refund_items"("refund_id");

-- CreateIndex
CREATE INDEX "ix_refund_items_order_item_id" ON "refund_items"("order_item_id");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_status" ON "admin_tasks"("status");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_type" ON "admin_tasks"("type");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_assigned_to" ON "admin_tasks"("assigned_to");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_order_id" ON "admin_tasks"("order_id");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_order_item_id" ON "admin_tasks"("order_item_id");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_refund_id" ON "admin_tasks"("refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_vouchers_code" ON "vouchers"("code");

-- CreateIndex
CREATE INDEX "ix_voucher_redemptions_order_id" ON "voucher_redemptions"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_voucher_redemptions_voucher_user" ON "voucher_redemptions"("voucher_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_voucher_products_product_id" ON "voucher_products"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_voucher_products_voucher_product" ON "voucher_products"("voucher_id", "product_id");

-- CreateIndex
CREATE INDEX "ix_reviews_product_id" ON "reviews"("product_id");

-- CreateIndex
CREATE INDEX "ix_reviews_status" ON "reviews"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_reviews_1" ON "reviews"("user_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_referrals_1" ON "referrals"("referee_id");

-- CreateIndex
CREATE INDEX "ix_referrals_referrer_id" ON "referrals"("referrer_id");

-- CreateIndex
CREATE INDEX "ix_support_tickets_user_id" ON "support_tickets"("user_id");

-- CreateIndex
CREATE INDEX "ix_support_tickets_closed_at" ON "support_tickets"("closed_at");

-- CreateIndex
CREATE INDEX "ix_support_tickets_order_id" ON "support_tickets"("order_id");

-- CreateIndex
CREATE INDEX "ix_support_tickets_status" ON "support_tickets"("status");

-- CreateIndex
CREATE INDEX "ix_support_tickets_priority" ON "support_tickets"("priority");

-- CreateIndex
CREATE INDEX "ix_ticket_messages_ticket_id" ON "ticket_messages"("ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_restock_subscriptions_1" ON "restock_subscriptions"("user_id", "product_id");

-- CreateIndex
CREATE INDEX "ix_cart_items_user_id" ON "cart_items"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "sqlite_autoindex_cart_items_1" ON "cart_items"("user_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_bulk_pricing_product_id" ON "bulk_pricing"("product_id");

-- CreateIndex
CREATE INDEX "ix_audit_logs_created_at" ON "audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "ix_audit_logs_target" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_notification_outbox_dedupe_key" ON "notification_outbox"("dedupe_key");

-- CreateIndex
CREATE INDEX "ix_notif_status_created" ON "notification_outbox"("status", "created_at");

-- CreateIndex
CREATE INDEX "ix_notification_outbox_order_id" ON "notification_outbox"("order_id");

-- CreateIndex
CREATE INDEX "ix_notification_outbox_status" ON "notification_outbox"("status");

-- CreateIndex
CREATE INDEX "ix_notification_outbox_created_at" ON "notification_outbox"("created_at");

-- CreateIndex
CREATE INDEX "ix_broadcasts_status" ON "broadcasts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ix_processed_binance_tx_txid" ON "processed_binance_tx"("binance_tx_id");

-- CreateIndex
CREATE INDEX "ix_processed_binance_tx_order_id" ON "processed_binance_tx"("order_id");

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

-- CreateIndex
CREATE UNIQUE INDEX "ix_idempotency_record_key_endpoint" ON "idempotency_records"("key", "endpoint");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_referred_by_id_fkey" FOREIGN KEY ("referred_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "provider_game_mappings" ADD CONSTRAINT "provider_game_mappings_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "denominations" ADD CONSTRAINT "denominations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_provider_mappings" ADD CONSTRAINT "product_provider_mappings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stock_items" ADD CONSTRAINT "stock_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refund_items" ADD CONSTRAINT "refund_items_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_tasks" ADD CONSTRAINT "admin_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_tasks" ADD CONSTRAINT "admin_tasks_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_tasks" ADD CONSTRAINT "admin_tasks_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_tasks" ADD CONSTRAINT "admin_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voucher_redemptions" ADD CONSTRAINT "voucher_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voucher_products" ADD CONSTRAINT "voucher_products_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "voucher_products" ADD CONSTRAINT "voucher_products_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_replied_by_admin_id_fkey" FOREIGN KEY ("replied_by_admin_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_fkey" FOREIGN KEY ("referee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "restock_subscriptions" ADD CONSTRAINT "restock_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "restock_subscriptions" ADD CONSTRAINT "restock_subscriptions_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bulk_pricing" ADD CONSTRAINT "bulk_pricing_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

