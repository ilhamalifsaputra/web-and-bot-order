/*
  Warnings:

  - You are about to drop the column `expected_region_code` on the `denominations` table. All the data in the column will be lost.
  - You are about to drop the column `region_warning` on the `denominations` table. All the data in the column will be lost.
  - You are about to drop the column `game_id` on the `products` table. All the data in the column will be lost.
  - You are about to drop the `games` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `provider_game_mappings` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "products" DROP CONSTRAINT "products_game_id_fkey";

-- DropForeignKey
ALTER TABLE "provider_game_mappings" DROP CONSTRAINT "provider_game_mappings_game_id_fkey";

-- DropIndex
DROP INDEX "ix_products_game_id";

-- AlterTable
ALTER TABLE "denominations" DROP COLUMN "expected_region_code",
DROP COLUMN "region_warning";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "game_id";

-- DropTable
DROP TABLE "games";

-- DropTable
DROP TABLE "provider_game_mappings";
