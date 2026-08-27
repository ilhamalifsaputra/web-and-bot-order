-- Turns the admin Reviews page into a Customer Feedback Management dashboard
-- (Task 1 of the reviews-module refactor). Reconciles the spec's two status
-- vocabularies into three orthogonal fields rather than collapsing them into
-- one enum:
--   * visibility  — existing `hidden` boolean, untouched (published/hidden).
--   * status      — NEW reply-workflow state: PENDING_REPLY | REPLIED |
--                    CLOSED (spec §11's set). Independent of `hidden`, so an
--                    admin can hide a review without it counting as "replied".
--   * source      — NEW provenance: CUSTOMER | SYSTEM_AUTO. Every existing
--                    and Phase-A row is CUSTOMER; SYSTEM_AUTO is reserved so
--                    the deferred auto-review job (Phase B) needs no further
--                    migration.
--   * sentiment   — NEW: POSITIVE | NEUTRAL | NEGATIVE, computed once and
--                    persisted (not derived on read) so it stays filterable/
--                    aggregatable from the dashboard.
--
-- REBUILD, NOT PLAIN ADD COLUMN (fixed 2026-08-03 — this file originally
-- shipped as six bare `ALTER TABLE ADD COLUMN` statements): status/source/
-- sentiment/admin_reply/replied_at can all take a plain ADD COLUMN (constant
-- literal default or nullable-no-default, both of which SQLite's ADD COLUMN
-- allows). But schema.prisma declares `repliedByAdmin User? @relation(fields:
-- [repliedByAdminId], ...)` on Review, which requires an FK constraint on
-- replied_by_admin_id — and SQLite's `ALTER TABLE ADD COLUMN` cannot add a
-- foreign key. A table rebuild (create-new/copy/drop/rename) is the only way
-- to add that column with its FK, so the whole set of new columns is folded
-- into one rebuild instead of five ADD COLUMNs plus one rebuild. `reviews`
-- has no incoming FKs from any other table (grep of schema.prisma confirms
-- no model holds a `Review` relation as a child), so unlike the
-- support_tickets rebuild this one carries no cascade-delete-on-drop hazard.
--
-- The sentiment backfill (rating >= 4 -> POSITIVE, rating <= 2 -> NEGATIVE,
-- else NEUTRAL) is folded directly into this rebuild's INSERT ... SELECT via
-- a CASE expression, rather than done as separate UPDATE statements after a
-- plain ADD COLUMN — the same pattern used by the support_tickets rebuild's
-- coalesce(...) backfill.
--
-- Every source column in the SELECT is table-qualified (`"reviews"."col"`,
-- not bare `"col"`) per check-migration-rebuild-quoting: Prisma's bundled
-- SQLite silently reinterprets a bare double-quoted name that matches no
-- column as a string literal instead of failing, which would corrupt data on
-- any database where this rebuild ran against a partially-applied `reviews`.
-- Qualified references cannot take that fallback.
--
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
DROP TABLE IF EXISTS "new_reviews";
CREATE TABLE "new_reviews" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REPLY',
    "source" TEXT NOT NULL DEFAULT 'CUSTOMER',
    "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL',
    "admin_reply" TEXT,
    "replied_at" DATETIME,
    "replied_by_admin_id" INTEGER,
    CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "reviews_replied_by_admin_id_fkey" FOREIGN KEY ("replied_by_admin_id") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
INSERT INTO "new_reviews" ("id", "user_id", "product_id", "order_id", "rating", "comment", "hidden", "created_at", "status", "source", "sentiment", "admin_reply", "replied_at", "replied_by_admin_id") SELECT "reviews"."id", "reviews"."user_id", "reviews"."product_id", "reviews"."order_id", "reviews"."rating", "reviews"."comment", "reviews"."hidden", "reviews"."created_at", 'PENDING_REPLY' AS "status", 'CUSTOMER' AS "source", CASE WHEN "reviews"."rating" >= 4 THEN 'POSITIVE' WHEN "reviews"."rating" <= 2 THEN 'NEGATIVE' ELSE 'NEUTRAL' END AS "sentiment", NULL AS "admin_reply", NULL AS "replied_at", NULL AS "replied_by_admin_id" FROM "reviews";
DROP TABLE "reviews";
ALTER TABLE "new_reviews" RENAME TO "reviews";
CREATE INDEX "ix_reviews_product_id" ON "reviews"("product_id");
CREATE INDEX "ix_reviews_status" ON "reviews"("status");
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_reviews_1" ON "reviews"("user_id", "order_id");
Pragma writable_schema=0;
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
