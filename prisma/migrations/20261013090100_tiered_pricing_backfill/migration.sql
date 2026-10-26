-- Tiered pricing backfill: carry every active single-rule bulk_pricing row over
-- as one PERCENTAGE tier and switch tiered pricing on for those SKUs. The old
-- bulk_pricing table is left untouched. Idempotent: re-running adds no tier.
-- Only rows activeBulkPercent (@app/core/bulk) would honour are carried over:
-- min_quantity >= 1 and 0 < discount_percent <= 100. Any other row never
-- discounted an order, so copying it would only create a tier every read has
-- to drop, and switch tiered pricing on for a SKU with nothing to price.
INSERT INTO "bulk_pricing_tiers" ("denomination_id", "min_quantity", "discount_type", "discount_value", "is_enabled", "sort_order", "created_at", "updated_at")
SELECT "product_id", "min_quantity", 'PERCENTAGE', "discount_percent", true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "bulk_pricing"
WHERE "is_active" = true AND "min_quantity" >= 1 AND "discount_percent" > 0 AND "discount_percent" <= 100
ON CONFLICT ("denomination_id", "min_quantity") DO NOTHING;

UPDATE "denominations"
SET "tiered_pricing_enabled" = true
WHERE "id" IN (
  SELECT "product_id" FROM "bulk_pricing"
  WHERE "is_active" = true AND "min_quantity" >= 1 AND "discount_percent" > 0 AND "discount_percent" <= 100
);
