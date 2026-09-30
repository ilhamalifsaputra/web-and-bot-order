-- Additive and nullable: legacy supplier names cannot be reconstructed truthfully.
ALTER TABLE "denominations" ADD COLUMN "supplier_raw_name" TEXT;
