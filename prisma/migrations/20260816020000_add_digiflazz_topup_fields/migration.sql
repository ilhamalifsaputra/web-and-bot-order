-- Task 1 (Digiflazz top-up pilot): three additive schema fields.
--
-- Hand-written rather than pasted verbatim from `prisma migrate diff
-- --script`, for the same reason as
-- prisma/migrations/20260801000000_catchup_missing_columns_and_indexes: SQLite's
-- `ALTER TABLE ADD COLUMN` accepts `NOT NULL DEFAULT <constant>`
-- (https://www.sqlite.org/lang_altertable.html — only non-constant defaults
-- like CURRENT_TIMESTAMP are rejected), but Prisma's own SQLite differ is more
-- conservative and unconditionally emits a full create-new/copy/drop/rename
-- table rebuild for ANY new NOT NULL+DEFAULT column — confirmed here too:
-- `checkout_flow TEXT NOT NULL DEFAULT 'catalog'` on `categories` produced
-- exactly that rebuild when run through `prisma migrate diff --script`. This
-- file replaces that rebuild with the same low-risk hand-authored ADD COLUMN
-- pattern already used by `20260718120000_add_broadcast_on_restock` and the
-- `delivery_type` column in `20260801000000_catchup_missing_columns_and_indexes`.
--
-- Verified: `pnpm run check-migration-drift` (`prisma migrate diff
-- --from-migrations ./prisma/migrations --to-schema-datamodel
-- ./prisma/schema.prisma --exit-code`) reports "No difference detected." after
-- this file — Prisma's diff engine compares resulting schema state, not the
-- SQL text/mechanism used to reach it, so a hand-written ADD COLUMN that lands
-- on the identical column name/type/nullability/default as the rebuild it
-- replaces is indistinguishable to it.
--
-- SAFETY: purely additive, no table rebuild, nothing dropped. `denominations`
-- and `orders` columns are plain nullable ADD COLUMNs (every existing row
-- gets NULL). `categories.checkout_flow` is NOT NULL DEFAULT 'catalog', so
-- every existing category is backfilled to "catalog" — the pre-existing
-- (only) checkout behavior — by the ADD COLUMN statement itself, no separate
-- backfill UPDATE required.
--
-- DEPLOY: apply with `pnpm exec prisma db push` (this repo's actual
-- mechanism — see docs/MIGRATIONS.md), then restart order-bot/web/storefront,
-- BOTH before any code that reads/writes these columns runs, or the first
-- query throws `P2022 column ... does not exist`. This file is the audit
-- trail for that change, not the thing that applies it.

-- AlterTable: denominations — the Digiflazz buyer_sku_code this SKU maps to.
ALTER TABLE "denominations" ADD COLUMN "supplier_sku" TEXT;

-- AlterTable: categories — checkout flow selector ("catalog" | "instant").
ALTER TABLE "categories" ADD COLUMN "checkout_flow" TEXT NOT NULL DEFAULT 'catalog';

-- AlterTable: orders — idempotency claim column for the Digiflazz dispatch
-- poller (a later task), mirroring the updateMany-with-status-guard pattern
-- `fulfillManualOrder` already uses (packages/db/src/crud/orders.ts:1657-1661).
ALTER TABLE "orders" ADD COLUMN "digiflazz_dispatched_at" DATETIME;
