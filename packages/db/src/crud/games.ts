/**
 * CRUD for Game / ProviderGameMapping — the multi-provider nickname check
 * feature's catalog layer. A Game is a nickname-checkable title (e.g. Mobile
 * Legends); each ProviderGameMapping pairs it with one supplier's internal
 * game code, ranked by `priority`, so the nickname-check flow can try
 * providers in order and fail over. Product.gameId (Task 2) links the
 * existing catalog to a Game; deleteGame refuses to run while any Product
 * still points at it, mirroring catalog.ts's deleteCategory guard.
 */
import type { Db } from "./_types";

/** All games, ordered by name, with their provider mappings included. */
export function listGames(db: Db) {
  return db.game.findMany({
    orderBy: { name: "asc" },
    include: { providerMappings: true },
  });
}

/** Single game by id, with its provider mappings included. */
export function getGame(db: Db, gameId: number) {
  return db.game.findUnique({
    where: { id: gameId },
    include: { providerMappings: true },
  });
}

export function getGameBySlug(db: Db, slug: string) {
  return db.game.findUnique({
    where: { slug },
    include: { providerMappings: true },
  });
}

export function createGame(
  db: Db,
  fields: {
    slug: string;
    name: string;
    category?: string | null;
    nicknameSupported?: boolean;
    requiresZone?: boolean;
    requiresServer?: boolean;
    isActive?: boolean;
  },
) {
  return db.game.create({ data: fields });
}

export function updateGame(
  db: Db,
  gameId: number,
  fields: Partial<{
    slug: string;
    name: string;
    category: string | null;
    nicknameSupported: boolean;
    requiresZone: boolean;
    requiresServer: boolean;
    isActive: boolean;
  }>,
) {
  return db.game.update({ where: { id: gameId }, data: fields });
}

/** Refuse to delete a game that any Product still references (reassign or clear
 * Product.gameId first). Provider mappings themselves cascade per the schema's
 * `onDelete: Cascade` once the delete is allowed to proceed. */
export async function deleteGame(db: Db, gameId: number): Promise<void> {
  const count = await db.product.count({ where: { gameId } });
  if (count > 0) {
    throw new Error("game still referenced by products: reassign or clear their gameId first");
  }
  await db.game.delete({ where: { id: gameId } });
}

/** All provider mappings for a game, ordered by priority ascending. */
export function listProviderMappingsForGame(db: Db, gameId: number) {
  return db.providerGameMapping.findMany({
    where: { gameId },
    orderBy: { priority: "asc" },
  });
}

/** Enabled provider mappings for a game, ordered by priority ascending — the
 * set the nickname-check flow should actually try, in order. */
export function getEnabledProviderMappingsForGame(db: Db, gameId: number) {
  return db.providerGameMapping.findMany({
    where: { gameId, enabled: true },
    orderBy: { priority: "asc" },
  });
}

/** Create or update the mapping for (gameId, provider), keyed on the schema's
 * `@@unique([gameId, provider])` compound key (Prisma-generated field name
 * `gameId_provider`). A second call for the same pair updates the existing
 * row in place rather than creating a duplicate. */
export function upsertProviderGameMapping(
  db: Db,
  fields: {
    gameId: number;
    provider: string;
    providerGameCode: string;
    enabled?: boolean;
    priority?: number;
  },
) {
  const { gameId, provider, providerGameCode, enabled, priority } = fields;
  return db.providerGameMapping.upsert({
    where: { gameId_provider: { gameId, provider } },
    create: { gameId, provider, providerGameCode, enabled, priority },
    update: { providerGameCode, enabled, priority },
  });
}

export async function deleteProviderGameMapping(db: Db, id: number): Promise<void> {
  await db.providerGameMapping.delete({ where: { id } });
}
