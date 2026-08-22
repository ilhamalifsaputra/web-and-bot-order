-- Digiflazz catalog auto-sync: two additive schema fields.
--
-- Hand-written for the same reason as 20260816020000_add_digiflazz_topup_fields
-- and 20260801000000_catchup_missing_columns_and_indexes: SQLite's own
-- `ALTER TABLE ADD COLUMN` accepts `NOT NULL DEFAULT <constant>` fine, but
-- Prisma's SQLite differ unconditionally rebuilds the table for any new
-- NOT NULL+DEFAULT column. This file produces the identical resulting schema
-- state via a plain ADD COLUMN instead.
--
-- Verify with: pnpm run check-migration-drift
--
-- SAFETY: purely additive. `products.digiflazz_brand` is a nullable ADD
-- COLUMN (every existing row gets NULL — no prior Product was
-- Digiflazz-imported). `denominations.price_overridden` is NOT NULL DEFAULT
-- 0, so every existing denomination is backfilled to "not overridden" (0 =
-- false) by the ADD COLUMN statement itself.
--
-- DEPLOY: apply with `pnpm exec prisma db push` (see docs/MIGRATIONS.md),
-- then restart order-bot/web/storefront before any code that reads/writes
-- these columns runs.

-- AlterTable: products — the Digiflazz brand string this Product was
-- imported from (Import Wizard re-sync matching key).
ALTER TABLE "products" ADD COLUMN "digiflazz_brand" TEXT;

-- AlterTable: denominations — set once an admin hand-edits price after
-- import, so the recurring re-sync job never overwrites a deliberate change.
ALTER TABLE "denominations" ADD COLUMN "price_overridden" BOOLEAN NOT NULL DEFAULT 0;
