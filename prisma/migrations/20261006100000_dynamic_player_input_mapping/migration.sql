ALTER TABLE "denominations" ADD COLUMN IF NOT EXISTS "provider_input_mapping" TEXT;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "input_config_snapshot" TEXT;
