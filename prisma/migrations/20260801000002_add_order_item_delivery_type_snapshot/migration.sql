-- M-5 (backend audit 2026-07-31): freeze Denomination.deliveryType onto each
-- OrderItem at order-creation time, mirroring warranty_days_snapshot. Without
-- this, settlePaidOrder read the LIVE denomination row to decide auto-vs-manual
-- delivery — editing deliveryType while an order was in flight could strand an
-- AUTO order's reserved stock (RESERVED forever, never released) or misroute a
-- MANUAL order into the auto-deliver branch and fail it out-of-stock.
--
-- Nullable, no default: this repo's real deploy convention is `prisma db push`
-- (docs/MIGRATIONS.md / CLAUDE.md), not `prisma migrate deploy` — the SQL file
-- below is documentation/audit-trail, not something that actually runs against
-- a live deploy. A NOT NULL DEFAULT would make `db push` silently mis-snapshot
-- every pre-existing row (including any order sitting in PENDING_VERIFICATION
-- right now) as "auto" the instant this ships, which is exactly the
-- manual->auto stranding bug this column exists to prevent. Instead, the
-- column is nullable and settlePaidOrder (packages/db/src/crud/orders.ts)
-- falls back to the live denomination row whenever the snapshot is null —
-- i.e. pre-migration rows keep behaving exactly as they did before this fix,
-- with zero regression risk at the deploy boundary. New rows (created after
-- this deploys) always get a real, immutable snapshot value.
--
-- RENUMBERED from 20260731120000 to 20260801000002 (final-review fix, this
-- branch, still pre-merge — the original folder never shipped, so renaming
-- breaks no `_prisma_migrations` checksum anywhere; confirmed by `git log
-- master -- prisma/migrations/20260731120000_*` returning nothing). The
-- original position sorted BEFORE 20260801000000_catchup_missing_columns_and_indexes,
-- which is the migration that actually creates `denominations.delivery_type`.
-- On a from-scratch `prisma migrate deploy` that ordering did not fail loudly
-- the way a missing-column reference normally would: the backfill UPDATE's
-- subquery referenced the column as a BARE double-quoted name
-- (`SELECT "delivery_type" FROM ...`), and Prisma's bundled SQLite has the
-- legacy double-quoted-string-literal fallback enabled, so a bare name that
-- matches no column silently became the string literal 'delivery_type'
-- instead of erroring — the exact H-9 idiom
-- (scripts/check-migration-rebuild-quoting.ts). Every existing order_items
-- row got the literal text "delivery_type" written into
-- delivery_type_snapshot, which packages/db/src/crud/orders.ts:1491 then
-- reads as `!== DeliveryType.AUTO`, i.e. every historical line item routed
-- into the manual-fulfilment branch — M-5's stranding bug, inverted.
-- Reproduced empirically on a scratch database before this fix (seeded one
-- denominations/order_items row, applied the migration chain in the original
-- order): delivery_type_snapshot came back as the literal string
-- "delivery_type". Fixed two ways, both required:
--   1. This file now sorts AFTER 20260801000000, so
--      `denominations.delivery_type` genuinely exists by the time the
--      backfill below runs.
--   2. The subquery now qualifies the column as
--      `"denominations"."delivery_type"` regardless — a qualified reference
--      can't take the bare-string-literal fallback, so if this file is ever
--      reordered again (or run against a database where the column is
--      somehow still missing), it aborts loudly instead of corrupting data.
-- Re-verified after both fixes: the same scratch-database reproduction now
-- applies the full chain cleanly and every seeded row's
-- delivery_type_snapshot matches its denomination's real delivery_type.

ALTER TABLE "order_items" ADD COLUMN "delivery_type_snapshot" TEXT;

-- Optional backfill, kept for anyone who DOES run `prisma migrate deploy`
-- (or restores from this migration chain directly): best-effort populates
-- existing rows from each item's CURRENT denomination delivery type (the same
-- value settlePaidOrder would have used before this fix existed). Under this
-- repo's actual `db push` deploy convention this UPDATE never runs at all —
-- the code's null-fallback in settlePaidOrder is what actually keeps
-- pre-existing rows safe, not this statement.
--
-- The source column is qualified as "denominations"."delivery_type", not
-- bare "delivery_type" — see the header above. A bare double-quoted name
-- that matched no column would be silently reinterpreted as a string
-- literal by Prisma's bundled SQLite instead of failing.
UPDATE "order_items"
SET "delivery_type_snapshot" = (
  SELECT "denominations"."delivery_type" FROM "denominations" WHERE "denominations"."id" = "order_items"."product_id"
)
WHERE "delivery_type_snapshot" IS NULL;
