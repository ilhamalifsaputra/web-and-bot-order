-- db push cannot represent this CHECK or partial expression index. Apply after
-- schema push on both fresh and existing databases. No rows are repaired or
-- deleted: legacy collisions or active archived rows must block deployment.
DO $$
BEGIN
  LOCK TABLE "denominations" IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"denominations"'::regclass
      AND conname = 'denominations_archive_inactive'
  ) THEN
    ALTER TABLE "denominations" ADD CONSTRAINT "denominations_archive_inactive"
      CHECK (NOT "is_archived" OR NOT "is_active");
  END IF;
  CREATE UNIQUE INDEX IF NOT EXISTS "ix_denominations_supplier_identity"
    ON "denominations" (COALESCE("auto_delivery_source", 'digiflazz'), "supplier_sku")
    WHERE "supplier_sku" IS NOT NULL AND NOT "is_archived";
END $$;
