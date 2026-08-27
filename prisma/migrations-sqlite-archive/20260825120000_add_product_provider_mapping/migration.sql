-- Task 4 (Trustance Master Architecture Phase 1): ProductProviderMapping —
-- the transaction-provider analogue of provider_game_mappings
-- (20260823192322_add_game_and_provider_mapping). Pure additive CREATE
-- TABLE + indexes, hand-written to match that migration's shape exactly
-- (same FK/index/unique pattern, swapping games/game_id for
-- denominations/product_id). Never touches an existing table, so this is
-- safe on a live DB with no backfill step and no risk to any existing
-- Digiflazz-routed Denomination — see this table's doc comment in
-- schema.prisma and .superpowers/sdd/task-4-brief.md for why
-- denominations.supplier_sku/auto_delivery_source (unchanged by this
-- migration) keep working unchanged for every row with no mapping.

-- CreateTable
CREATE TABLE "product_provider_mappings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "product_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_sku" TEXT NOT NULL,
    "provider_cost" DECIMAL,
    "cost_synced_at" DATETIME,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "product_provider_mappings_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "ix_product_provider_mappings_product_priority" ON "product_provider_mappings"("product_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ix_product_provider_mappings_product_provider" ON "product_provider_mappings"("product_id", "provider");
