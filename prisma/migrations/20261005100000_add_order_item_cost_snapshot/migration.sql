-- Freeze per-unit catalog cost in IDR on each new order line so supplier
-- resyncs do not rewrite historical profit. Nullable with no default or
-- backfill: legacy rows retain the live-catalog fallback.
ALTER TABLE "order_items" ADD COLUMN "cost_snapshot" DECIMAL(65,30);
