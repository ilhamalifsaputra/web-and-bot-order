-- Task 2 (multi-provider nickname check, 2026-08-23): adds a nullable
-- `Product.gameId` FK to the new `games` table (see the prior migration,
-- 20260823192322_add_game_and_provider_mapping). SQLite's `ALTER TABLE ADD
-- COLUMN` cannot attach a real foreign-key constraint, so Prisma's differ
-- chose its standard SQLite "redefine table" rebuild instead of a plain
-- ADD COLUMN — verified via `prisma migrate diff --script` before writing
-- this file by hand (this repo's real deploy mechanism is `prisma db push`,
-- not `prisma migrate deploy`; this file is documentation/audit-trail only,
-- per docs/MIGRATIONS.md).
--
-- Safety review (products is a cascade-parent to denominations, which is
-- itself a cascade-parent to 5 more tables — stock_items, cart_items,
-- restock_subscriptions, reviews, bulk_pricing):
--   * Every existing column is carried through unchanged; the only new
--     column is the nullable `game_id`, which is not in the INSERT/SELECT
--     list below, so every pre-existing row gets NULL (safe, no data loss).
--   * `id` values are preserved exactly (selected/copied verbatim), so
--     every child row's `product_id`/`category_id`-style FK — and every
--     denomination's `product_id` — keeps pointing at the same logical
--     product after the rebuild.
--   * The new `products_game_id_fkey` is `ON DELETE SET NULL`, matching
--     the nullable/optional relation (deleting a Game un-links its
--     Products rather than deleting them).
--   * Every source column in the copy SELECT is qualified as
--     "products"."<column>" (not a bare "<column>"), per
--     scripts/check-migration-rebuild-quoting.ts / docs/MIGRATIONS.md's H-9
--     guard — a qualified reference can't silently fall back to a string
--     literal if the source table is ever missing a column, even in a
--     single-table copy like this one.
--   * Verified empirically against a real copy of this shop's catalog
--     (18 products / 236 denominations) via `prisma db push`: row counts
--     identical before and after, zero data-loss warnings from Prisma.

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_products" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "category_id" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "emoji" TEXT,
    "description" TEXT,
    "what_you_get" TEXT,
    "terms" TEXT,
    "warranty_note" TEXT,
    "web_image_url" TEXT,
    "image_file_id" TEXT,
    "digiflazz_brand" TEXT,
    "game_variant" TEXT,
    "game_variant_emoji" TEXT,
    "game_region" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "game_id" INTEGER,
    CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "products_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_products" ("category_id", "created_at", "description", "digiflazz_brand", "emoji", "game_region", "game_variant", "game_variant_emoji", "id", "image_file_id", "is_active", "is_archived", "name", "slug", "sort_order", "terms", "warranty_note", "web_image_url", "what_you_get") SELECT "products"."category_id", "products"."created_at", "products"."description", "products"."digiflazz_brand", "products"."emoji", "products"."game_region", "products"."game_variant", "products"."game_variant_emoji", "products"."id", "products"."image_file_id", "products"."is_active", "products"."is_archived", "products"."name", "products"."slug", "products"."sort_order", "products"."terms", "products"."warranty_note", "products"."web_image_url", "products"."what_you_get" FROM "products";
DROP TABLE "products";
ALTER TABLE "new_products" RENAME TO "products";
CREATE UNIQUE INDEX "ix_products_slug" ON "products"("slug");
CREATE INDEX "ix_products_category_id" ON "products"("category_id");
CREATE INDEX "ix_products_game_id" ON "products"("game_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
