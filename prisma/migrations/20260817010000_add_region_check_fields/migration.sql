-- Region-check Task B: two additive schema fields.
--
-- Hand-written for the same reason as 20260817000000_add_nickname_check_game_code
-- and its predecessors: SQLite's own `ALTER TABLE ADD COLUMN` accepts a plain
-- nullable column fine, and neither of these carries a NOT NULL/DEFAULT, so
-- there is no rebuild-vs-ADD-COLUMN question here — this file just keeps the
-- same hand-authored-migration convention the rest of this project's schema
-- changes use.
--
-- Verify with: pnpm run check-migration-drift
--
-- SAFETY: purely additive. `denominations.region_warning` and
-- `denominations.expected_region_code` are nullable ADD COLUMNs (every
-- existing row gets NULL — no prior denomination had either configured).
-- Null means "no manual warning" / "no automatic region check", which is the
-- existing (only) behavior, so no backfill is needed.
--
-- DEPLOY: apply with `pnpm exec prisma db push` (see docs/MIGRATIONS.md),
-- then restart order-bot/web/storefront before any code that reads/writes
-- these columns runs.

-- AlterTable: denominations — admin-authored warning text shown near the
-- account field on the storefront's instant-buy page. Null = no warning
-- shown, works exactly as it does today.
ALTER TABLE "denominations" ADD COLUMN "region_warning" TEXT;

-- AlterTable: denominations — the ISO-3166-alpha2-ish region code this SKU
-- is FOR, compared against VIP-Reseller's live region-check result (Task A).
-- Null = no automatic region check for this SKU, skipped silently.
ALTER TABLE "denominations" ADD COLUMN "expected_region_code" TEXT;
