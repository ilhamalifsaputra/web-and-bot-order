-- Pricing & Margins: an optional per-category markup rule for supplier-costed
-- SKUs. Both columns null (every existing row) means "inherit the global
-- default markup", so this changes no price. No backfill.
ALTER TABLE "categories" ADD COLUMN "markup_type" TEXT;
ALTER TABLE "categories" ADD COLUMN "markup_value" DECIMAL(65,30);
