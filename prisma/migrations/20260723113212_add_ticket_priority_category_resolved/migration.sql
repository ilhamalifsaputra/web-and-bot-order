-- AlterTable
ALTER TABLE "orders" ADD COLUMN "customer_data" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivered_content" TEXT;

-- AlterTable
ALTER TABLE "products" ADD COLUMN "terms" TEXT;
ALTER TABLE "products" ADD COLUMN "warranty_note" TEXT;
ALTER TABLE "products" ADD COLUMN "what_you_get" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_denominations" (
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
    "delivery_type" TEXT NOT NULL DEFAULT 'auto',
    "additional_fields" TEXT,
    "warranty_days" INTEGER NOT NULL DEFAULT 30,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "broadcast_on_restock" BOOLEAN NOT NULL DEFAULT false,
    "flash_discount_percent" DECIMAL,
    "flash_starts_at" DATETIME,
    "flash_ends_at" DATETIME,
    "flash_announced_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "denominations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
INSERT INTO "new_denominations" ("auto_delivery_source", "broadcast_on_restock", "cost_price", "created_at", "description", "duration_label", "id", "image_file_id", "is_active", "name", "price", "product_id", "reseller_price", "slug", "sort_order", "type", "warranty_days", "web_image_url") SELECT "auto_delivery_source", "broadcast_on_restock", "cost_price", "created_at", "description", "duration_label", "id", "image_file_id", "is_active", "name", "price", "product_id", "reseller_price", "slug", "sort_order", "type", "warranty_days", "web_image_url" FROM "denominations";
DROP TABLE "denominations";
ALTER TABLE "new_denominations" RENAME TO "denominations";
CREATE UNIQUE INDEX "ix_denominations_slug" ON "denominations"("slug");
CREATE INDEX "ix_denominations_product_id" ON "denominations"("product_id");
CREATE INDEX "ix_denominations_flash_ends_at" ON "denominations"("flash_ends_at");
CREATE TABLE "new_support_tickets" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "message" TEXT NOT NULL,
    "photo_file_ids" TEXT,
    "attachment_urls" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT,
    "admin_reply" TEXT,
    "admin_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replied_at" DATETIME,
    "first_response_at" DATETIME,
    "resolved_at" DATETIME,
    "closed_at" DATETIME,
    "last_status_change_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "support_tickets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
INSERT INTO "new_support_tickets" ("admin_id", "admin_reply", "attachment_urls", "created_at", "id", "message", "photo_file_ids", "replied_at", "status", "user_id") SELECT "admin_id", "admin_reply", "attachment_urls", "created_at", "id", "message", "photo_file_ids", "replied_at", "status", "user_id" FROM "support_tickets";
DROP TABLE "support_tickets";
ALTER TABLE "new_support_tickets" RENAME TO "support_tickets";
CREATE INDEX "ix_support_tickets_user_id" ON "support_tickets"("user_id");
CREATE INDEX "ix_support_tickets_closed_at" ON "support_tickets"("closed_at");
CREATE INDEX "ix_support_tickets_status" ON "support_tickets"("status");
CREATE INDEX "ix_support_tickets_priority" ON "support_tickets"("priority");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
