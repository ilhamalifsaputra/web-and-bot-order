-- CreateTable
CREATE TABLE "games" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "nickname_supported" BOOLEAN NOT NULL DEFAULT true,
    "requires_zone" BOOLEAN NOT NULL DEFAULT false,
    "requires_server" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "provider_game_mappings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game_id" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_game_code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "provider_game_mappings_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_games_slug" ON "games"("slug");

-- CreateIndex
CREATE INDEX "ix_provider_game_mappings_game_priority" ON "provider_game_mappings"("game_id", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "ix_provider_game_mappings_game_provider" ON "provider_game_mappings"("game_id", "provider");
