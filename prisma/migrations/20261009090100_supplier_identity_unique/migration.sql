-- Legacy collisions deliberately block deployment. See docs/digiflazz-duplicate-bulk-delete.md.
-- No data is silently repaired or deleted.
DO $$ BEGIN
  IF EXISTS (SELECT supplier_sku FROM denominations WHERE supplier_sku IS NOT NULL AND NOT is_archived
             GROUP BY COALESCE(auto_delivery_source, 'digiflazz'), supplier_sku HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate supplier SKU ownership: run audit-digiflazz-duplicates and explicitly reconcile before deploying this index';
  END IF;
END $$;
CREATE UNIQUE INDEX ix_denominations_supplier_identity
  ON denominations (COALESCE(auto_delivery_source, 'digiflazz'), supplier_sku)
  WHERE supplier_sku IS NOT NULL AND NOT is_archived;
