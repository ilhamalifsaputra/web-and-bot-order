-- M-5 (backend audit 2026-07-31): freeze Denomination.deliveryType onto each
-- OrderItem at order-creation time, mirroring warranty_days_snapshot. Without
-- this, settlePaidOrder read the LIVE denomination row to decide auto-vs-manual
-- delivery — editing deliveryType while an order was in flight could strand an
-- AUTO order's reserved stock (RESERVED forever, never released) or misroute a
-- MANUAL order into the auto-deliver branch and fail it out-of-stock.

ALTER TABLE "order_items" ADD COLUMN "delivery_type_snapshot" TEXT NOT NULL DEFAULT 'auto';

-- Best-effort backfill for existing rows from each item's CURRENT denomination
-- delivery type (the same value settlePaidOrder would have used before this
-- fix existed). Only meaningful for orders still in flight at migration time;
-- already-settled orders are unaffected either way.
UPDATE "order_items"
SET "delivery_type_snapshot" = COALESCE(
  (SELECT "delivery_type" FROM "denominations" WHERE "denominations"."id" = "order_items"."product_id"),
  'auto'
);
