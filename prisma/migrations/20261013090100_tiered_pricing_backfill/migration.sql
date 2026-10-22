-- Tiered pricing backfill: carry every active single-rule bulk_pricing row over
-- as one PERCENTAGE tier and switch tiered pricing on for those SKUs. The old
-- bulk_pricing table is left untouched. Idempotent: re-running adds no tier.
INSERT INTO "bulk_pricing_tiers" ("denomination_id", "min_quantity", "discount_type", "discount_value", "is_enabled", "sort_order", "created_at", "updated_at")
SELECT "product_id", "min_quantity", 'PERCENTAGE', "discount_percent", true, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "bulk_pricing"
WHERE "is_active" = true
ON CONFLICT ("denomination_id", "min_quantity") DO NOTHING;

UPDATE "denominations"
SET "tiered_pricing_enabled" = true
WHERE "id" IN (SELECT "product_id" FROM "bulk_pricing" WHERE "is_active" = true);
