-- H-8 catch-up migration (part 1/2 — safe, additive-only, no table rebuild).
--
-- schema.prisma had drifted ahead of prisma/migrations/* (day-to-day deploys
-- use `prisma db push`, which doesn't write migration files, so undocumented
-- columns/indexes accumulated unnoticed). A fresh `prisma migrate deploy`
-- against an empty database would fail with P2022 the moment the catalog is
-- read. See prisma/migrations/20260801000001_support_tickets_last_status_change_not_null
-- for the one remaining catch-up change (deliberately split out — see that
-- file's header for why).
--
-- Every statement below is a plain `ALTER TABLE ADD COLUMN` / `CREATE INDEX`
-- — nothing here drops or rebuilds a table, so there is no cascade-delete
-- exposure on denominations' or support_tickets' FK children regardless of
-- how/when this runs (transaction or not, PRAGMA foreign_keys on or off).
--
-- Hand-written rather than pasted verbatim from `prisma migrate diff
-- --script`, because Prisma's own SQLite differ is more conservative than
-- SQLite itself: SQLite's `ALTER TABLE ADD COLUMN` accepts `NOT NULL DEFAULT
-- <constant>` (see https://www.sqlite.org/lang_altertable.html — rejected
-- only for non-constant defaults like CURRENT_TIMESTAMP), but Prisma's
-- differ unconditionally emits a full create-new/copy/drop/rename rebuild
-- for ANY new NOT NULL+DEFAULT column, verified empirically while
-- investigating this migration (confirmed by toggling `deliveryType` between
-- nullable and `NOT NULL @default("auto")` in a scratch copy of
-- schema.prisma and re-running `prisma migrate diff`: nullable produces
-- plain ADD COLUMN, NOT NULL+DEFAULT produces a full rebuild — reproduced
-- again on an unrelated NOT NULL+DEFAULT boolean field added to `products`
-- to rule out a `denominations`-specific cause). `delivery_type TEXT NOT
-- NULL DEFAULT 'auto'` is exactly the same low-risk pattern this repo's own
-- `20260718120000_add_broadcast_on_restock` already used successfully
-- (`ALTER TABLE "denominations" ADD COLUMN "broadcast_on_restock" BOOLEAN
-- NOT NULL DEFAULT false;`) — a hand-authored ADD COLUMN, not a rebuild,
-- for the exact same reason.
--
-- Verified: re-running `prisma migrate diff --from-migrations
-- ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma
-- --exit-code` after both this file and the companion 000001 file reports
-- "No difference detected." (exit 0) — Prisma's diff engine compares
-- resulting schema state, not the SQL text/mechanism used to reach it, so a
-- hand-written ADD COLUMN that lands on the identical column
-- name/type/nullability/default as the rebuild it replaces is
-- indistinguishable to it.

-- AlterTable: orders
ALTER TABLE "orders" ADD COLUMN "customer_data" TEXT;
ALTER TABLE "orders" ADD COLUMN "delivered_content" TEXT;
ALTER TABLE "orders" ADD COLUMN "tracking_stale_at" DATETIME;

-- AlterTable: products
ALTER TABLE "products" ADD COLUMN "terms" TEXT;
ALTER TABLE "products" ADD COLUMN "warranty_note" TEXT;
ALTER TABLE "products" ADD COLUMN "what_you_get" TEXT;

-- AlterTable: denominations (parent of 5 ON DELETE CASCADE children —
-- bulk_pricing, cart_items, restock_subscriptions, reviews, stock_items —
-- which is exactly why this file avoids a rebuild for it)
ALTER TABLE "denominations" ADD COLUMN "delivery_type" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "denominations" ADD COLUMN "additional_fields" TEXT;
ALTER TABLE "denominations" ADD COLUMN "flash_discount_percent" DECIMAL;
ALTER TABLE "denominations" ADD COLUMN "flash_starts_at" DATETIME;
ALTER TABLE "denominations" ADD COLUMN "flash_ends_at" DATETIME;
ALTER TABLE "denominations" ADD COLUMN "flash_announced_at" DATETIME;
CREATE INDEX "ix_denominations_flash_ends_at" ON "denominations"("flash_ends_at");

-- AlterTable: support_tickets — closed_at only. The OTHER outstanding
-- support_tickets change (last_status_change_at nullable -> NOT NULL) is
-- NOT a new column — it's a constraint change on an EXISTING column, which
-- SQLite genuinely cannot do via ALTER TABLE under any form (there is no
-- ALTER COLUMN in SQLite), unlike delivery_type above. That one really does
-- require a rebuild, and support_tickets has its own ON DELETE CASCADE
-- child (ticket_messages), so it's deliberately isolated into its own
-- migration file (20260801000001) with its own explicit risk warning
-- instead of being silently bundled in here.
ALTER TABLE "support_tickets" ADD COLUMN "closed_at" DATETIME;
CREATE INDEX "ix_support_tickets_closed_at" ON "support_tickets"("closed_at");
