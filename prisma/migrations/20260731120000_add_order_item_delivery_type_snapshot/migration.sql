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
-- (Also note: no migration in this history ever creates denominations.delivery_type
-- itself, so this file would fail if `prisma migrate deploy` were ever run from
-- scratch against an empty database — a pre-existing gap in this migration
-- chain, not introduced here.)

ALTER TABLE "order_items" ADD COLUMN "delivery_type_snapshot" TEXT;

-- Optional backfill, kept for anyone who DOES run `prisma migrate deploy`
-- (or restores from this migration chain directly): best-effort populates
-- existing rows from each item's CURRENT denomination delivery type (the same
-- value settlePaidOrder would have used before this fix existed). Under this
-- repo's actual `db push` deploy convention this UPDATE never runs at all —
-- the code's null-fallback in settlePaidOrder is what actually keeps
-- pre-existing rows safe, not this statement.
UPDATE "order_items"
SET "delivery_type_snapshot" = (
  SELECT "delivery_type" FROM "denominations" WHERE "denominations"."id" = "order_items"."product_id"
)
WHERE "delivery_type_snapshot" IS NULL;
