/**
 * CRUD tests for Game / ProviderGameMapping — the multi-provider nickname
 * check feature's catalog layer. Follows crud/stock.test.ts's makeTestDb +
 * resetDb + buildSampleData shape; games/provider_game_mappings aren't wiped
 * by the shared resetDb (it predates these tables), so this file clears them
 * itself in beforeEach.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  listGames,
  getGame,
  getGameBySlug,
  createGame,
  updateGame,
  deleteGame,
  listProviderMappingsForGame,
  getEnabledProviderMappingsForGame,
  upsertProviderGameMapping,
  deleteProviderGameMapping,
} from "./games";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  // Not covered by the shared resetDb (added after it was written).
  await prisma.providerGameMapping.deleteMany();
  await prisma.game.deleteMany();
  sample = await buildSampleData(prisma);
});

describe("createGame / getGame / getGameBySlug", () => {
  it("creates a game and reads it back by id and by slug", async () => {
    const created = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });

    const byId = await getGame(prisma, created.id);
    const bySlug = await getGameBySlug(prisma, "mobile-legends");

    expect(byId?.id).toBe(created.id);
    expect(byId?.name).toBe("Mobile Legends");
    expect(bySlug?.id).toBe(created.id);
  });

  it("defaults nicknameSupported/requiresZone/requiresServer/isActive per schema", async () => {
    const created = await createGame(prisma, { slug: "genshin-impact", name: "Genshin Impact" });
    expect(created.nicknameSupported).toBe(true);
    expect(created.requiresZone).toBe(false);
    expect(created.requiresServer).toBe(false);
    expect(created.isActive).toBe(true);
  });
});

describe("listGames", () => {
  it("returns all games ordered by name with providerMappings included", async () => {
    await createGame(prisma, { slug: "zzz-game", name: "Zzz Game" });
    await createGame(prisma, { slug: "aaa-game", name: "Aaa Game" });

    const games = await listGames(prisma);

    expect(games.map((g) => g.name)).toEqual(["Aaa Game", "Zzz Game"]);
    expect(games[0]?.providerMappings).toEqual([]);
  });
});

describe("updateGame", () => {
  it("changes the given fields and leaves others intact", async () => {
    const created = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });

    const updated = await updateGame(prisma, created.id, { name: "Mobile Legends: Bang Bang", requiresZone: true });

    expect(updated.name).toBe("Mobile Legends: Bang Bang");
    expect(updated.requiresZone).toBe(true);
    expect(updated.slug).toBe("mobile-legends");
  });
});

describe("deleteGame", () => {
  it("succeeds when no Product references the game", async () => {
    const created = await createGame(prisma, { slug: "free-fire", name: "Free Fire" });

    await deleteGame(prisma, created.id);

    expect(await getGame(prisma, created.id)).toBeNull();
  });

  it("throws when a Product's gameId still references the game", async () => {
    const created = await createGame(prisma, { slug: "pubg-mobile", name: "PUBG Mobile" });
    await prisma.product.update({ where: { id: sample.parentProduct.id }, data: { gameId: created.id } });

    await expect(deleteGame(prisma, created.id)).rejects.toThrow();

    // Refused, not partially applied — the game must still exist.
    expect(await getGame(prisma, created.id)).not.toBeNull();
  });
});

describe("upsertProviderGameMapping", () => {
  it("creates a new row on first call, then updates the same row in place", async () => {
    const game = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });

    const first = await upsertProviderGameMapping(prisma, {
      gameId: game.id,
      provider: "kokinpay",
      providerGameCode: "ML001",
      priority: 1,
    });
    const second = await upsertProviderGameMapping(prisma, {
      gameId: game.id,
      provider: "kokinpay",
      providerGameCode: "ML002",
      priority: 5,
      enabled: false,
    });

    const rows = await prisma.providerGameMapping.findMany({ where: { gameId: game.id, provider: "kokinpay" } });
    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(second.providerGameCode).toBe("ML002");
    expect(second.priority).toBe(5);
    expect(second.enabled).toBe(false);
  });
});

describe("getEnabledProviderMappingsForGame / listProviderMappingsForGame", () => {
  it("listProviderMappingsForGame returns all rows ordered by priority ascending", async () => {
    const game = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "melostore", providerGameCode: "ML-C", priority: 3 });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "ML-A", priority: 1 });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "vipreseller", providerGameCode: "ML-B", priority: 2 });

    const rows = await listProviderMappingsForGame(prisma, game.id);

    expect(rows.map((r) => r.provider)).toEqual(["kokinpay", "vipreseller", "melostore"]);
  });

  it("excludes disabled rows and orders enabled ones by priority ascending", async () => {
    const game = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "ML-A", priority: 2, enabled: true });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "vipreseller", providerGameCode: "ML-B", priority: 0, enabled: true });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "melostore", providerGameCode: "ML-C", priority: 1, enabled: false });

    const rows = await getEnabledProviderMappingsForGame(prisma, game.id);

    expect(rows.map((r) => r.provider)).toEqual(["vipreseller", "kokinpay"]);
    expect(rows.every((r) => r.enabled)).toBe(true);
  });
});

describe("deleteProviderGameMapping", () => {
  it("deletes the given mapping row", async () => {
    const game = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });
    const mapping = await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "ML001" });

    await deleteProviderGameMapping(prisma, mapping.id);

    expect(await prisma.providerGameMapping.findUnique({ where: { id: mapping.id } })).toBeNull();
  });
});

describe("[gameId, provider] unique constraint", () => {
  it("rejects a raw duplicate-pair create", async () => {
    const game = await createGame(prisma, { slug: "mobile-legends", name: "Mobile Legends" });
    await prisma.providerGameMapping.create({
      data: { gameId: game.id, provider: "kokinpay", providerGameCode: "ML001" },
    });

    await expect(
      prisma.providerGameMapping.create({
        data: { gameId: game.id, provider: "kokinpay", providerGameCode: "ML999" },
      }),
    ).rejects.toThrow();
  });
});
