-- Read-only production audit — stock traceability hardening plan, Fase 4a.
--
-- Run this against PRODUCTION before Fase 4b adds `@unique` to
-- OrderItem.stockItemId. That column-level constraint can only be applied
-- (via `prisma db push` — see docs/MIGRATIONS.md; this repo does not run
-- `prisma migrate deploy`) once the data underneath it is already clean, so
-- this script answers "is it clean?" without changing anything.
--
-- It contains ONLY SELECT statements. It reads four things:
--   (a) StockItem ids referenced by more than one OrderItem — the exact
--       shape the unique constraint will forbid. Each is expanded to the
--       order ids/statuses holding that pointer so you can tell whether it
--       is live (a real double-sale) or an old cancelled/rejected order that
--       predates releaseOrderHolds nulling the pointer (Fase 3b).
--   (b) A single count of OrderItem rows whose order is CANCELLED/REJECTED
--       but which still point at a StockItem — releaseOrderHolds should null
--       this going forward; a non-zero count here is legacy data from before
--       that fix landed.
--   (c) StockItem rows marked SOLD whose recorded buyer order (soldToOrderId,
--       stamped at the moment of sale — see packages/db/src/crud/orders.ts)
--       is missing or not DELIVERED — a sign the sale and the order's own
--       status diverged (e.g. a later REFUNDED/CANCELLED without the stock
--       row being corrected back).
--   (d) A plain count of StockItem rows per status, for scale/context when
--       reading (a)-(c).
--
-- How to run it (any of these; all are read-only, none require the app to be
-- stopped):
--   psql "$DATABASE_URL_PRISMA" -f scripts/audit-stock-duplicates.sql
--   psql "postgresql://user:pass@host:5432/dbname" -f scripts/audit-stock-duplicates.sql
-- ...or paste the whole file into any Postgres GUI client (pgAdmin, DBeaver,
-- TablePlus) connected to the production database and run it as one script.
--
-- How to read the output: four result sets print in the order above. Report
-- the row counts of each back — for (a) and (c), the actual StockItem ids
-- found are the useful part (never their credential text, which this script
-- never selects); for (b) and (d), the single number/breakdown is enough.
-- Zero rows in (a), (b) and (c) means the dataset is already clean and
-- Fase 4b's unique constraint can be applied without a data-cleanup step
-- first.

-- (a) StockItem ids pointed at by more than one OrderItem.
SELECT
  oi.stock_item_id,
  array_agg(oi.id ORDER BY oi.id)     AS order_item_ids,
  array_agg(o.id ORDER BY oi.id)      AS order_ids,
  array_agg(o.status ORDER BY oi.id)  AS order_statuses
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.stock_item_id IS NOT NULL
GROUP BY oi.stock_item_id
HAVING COUNT(*) > 1
ORDER BY oi.stock_item_id;

-- (b) Count of OrderItems of a CANCELLED/REJECTED order that still point at
-- a StockItem (should be nulled by releaseOrderHolds — Fase 3b).
SELECT COUNT(*) AS cancelled_or_rejected_order_items_still_linked
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE oi.stock_item_id IS NOT NULL
  AND o.status IN ('CANCELLED', 'REJECTED');

-- (c) SOLD StockItem rows without a matching DELIVERED order.
SELECT
  si.id AS stock_item_id,
  si.sold_to_order_id,
  o.status AS order_status
FROM stock_items si
LEFT JOIN orders o ON o.id = si.sold_to_order_id
WHERE si.status = 'SOLD'
  AND (si.sold_to_order_id IS NULL OR o.status IS DISTINCT FROM 'DELIVERED')
ORDER BY si.id;

-- (d) StockItem row counts by status, for scale/context.
SELECT status, COUNT(*) AS count
FROM stock_items
GROUP BY status
ORDER BY status;
