-- H-8 catch-up migration: `schema.prisma` had drifted ahead of
-- `prisma/migrations/*` (day-to-day deploys use `prisma db push`, which
-- doesn't write migration files, so a slow accumulation of undocumented
-- columns/indexes went unnoticed until a fresh `prisma migrate deploy`
-- against an empty database would fail with P2022 the moment the catalog
-- is read). Generated verbatim via:
--   prisma migrate diff --from-migrations ./prisma/migrations \
--     --to-schema-datamodel ./prisma/schema.prisma --script
--
-- Reviewed as additive/data-preserving:
--  - orders / products sections are plain `ALTER TABLE ADD COLUMN` (new
--    columns are declared at the end of their models in schema.prisma, so
--    SQLite's simple ADD COLUMN path applies — no rebuild needed).
--  - denominations / support_tickets go through SQLite's standard
--    create-new-table/copy/drop/rename idiom (Prisma's "RedefineTables"
--    step) instead, because their new columns
--    (delivery_type/additional_fields/flash_*, closed_at) are declared in
--    the MIDDLE of the model in schema.prisma, not appended at the end —
--    a plain ADD COLUMN can only append, so Prisma rebuilds the table to
--    match declared column order exactly. Both rebuilds were checked
--    column-by-column: every pre-existing column is carried over via an
--    explicit `INSERT INTO new_<table> (...) SELECT (...) FROM <table>`
--    (nothing dropped, nothing renamed), and every newly-added column is
--    either nullable or has a DEFAULT applied by SQLite for rows that
--    don't supply it. No DROP COLUMN, no data-loss warnings anywhere in
--    the generated script.
--  - support_tickets additionally tightens `last_status_change_at` from
--    nullable (the only form SQLite's plain ALTER TABLE ADD COLUMN could
--    produce for a non-constant default — see
--    20260725000000_add_ticket_priority_category_resolved) to NOT NULL
--    DEFAULT CURRENT_TIMESTAMP, matching schema.prisma's
--    `@default(now())`. The copy uses
--    `coalesce("last_status_change_at", CURRENT_TIMESTAMP)` so any
--    legacy null (there shouldn't be any live ones — every write path
--    already sets this column explicitly) gets backfilled instead of
--    violating the new NOT NULL constraint.
--
-- New columns added here (13 total): orders.customer_data,
-- orders.delivered_content, orders.tracking_stale_at,
-- products.terms, products.warranty_note, products.what_you_get,
-- denominations.delivery_type, denominations.additional_fields,
-- denominations.flash_discount_percent, denominations.flash_starts_at,
-- denominations.flash_ends_at, denominations.flash_announced_at,
-- support_tickets.closed_at.
-- New indexes added here (2): ix_denominations_flash_ends_at,
-- ix_support_tickets_closed_at.
--
-- As with every migration folder in this repo, this file is an audit-trail
-- SQL record — the actual deploy mechanism is `prisma db push`
-- (see docs/MIGRATIONS.md), which will apply the equivalent column/index
-- changes directly against the live schema, additively and without any
-- interactive destructive-change prompt (no column here is NOT NULL
-- without a default, and no existing column's data is altered).

-- AlterTable
ALTER TABLE "orders" ADD COLUMN "customer_data" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivered_content" TEXT;
ALTER TABLE "orders" ADD COLUMN "tracking_stale_at" DATETIME;

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
    "order_id" INTEGER,
    "last_status_change_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_tickets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "support_tickets_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "support_tickets_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_support_tickets" ("admin_id", "admin_reply", "attachment_urls", "category", "created_at", "first_response_at", "id", "last_status_change_at", "message", "order_id", "photo_file_ids", "priority", "replied_at", "resolved_at", "status", "user_id") SELECT "admin_id", "admin_reply", "attachment_urls", "category", "created_at", "first_response_at", "id", coalesce("last_status_change_at", CURRENT_TIMESTAMP) AS "last_status_change_at", "message", "order_id", "photo_file_ids", "priority", "replied_at", "resolved_at", "status", "user_id" FROM "support_tickets";
DROP TABLE "support_tickets";
ALTER TABLE "new_support_tickets" RENAME TO "support_tickets";
CREATE INDEX "ix_support_tickets_user_id" ON "support_tickets"("user_id");
CREATE INDEX "ix_support_tickets_closed_at" ON "support_tickets"("closed_at");
CREATE INDEX "ix_support_tickets_order_id" ON "support_tickets"("order_id");
CREATE INDEX "ix_support_tickets_status" ON "support_tickets"("status");
CREATE INDEX "ix_support_tickets_priority" ON "support_tickets"("priority");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
