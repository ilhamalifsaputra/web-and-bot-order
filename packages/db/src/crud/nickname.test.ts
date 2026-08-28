/**
 * Tests for buildNicknameProviderEntries (Trustance reconciliation Phase B,
 * Task 1 — extracted from apps/storefront/src/routes/apiTopup.ts's inline
 * gameId/ProviderGameMapping resolution). Follows crud/games.test.ts's
 * makeTestDb + resetDb + buildSampleData shape; games/provider_game_mappings
 * aren't wiped by the shared resetDb, so this file clears them itself in
 * beforeEach, same as games.test.ts.
 *
 * The gameId-branch cases here mirror
 * apps/storefront/test/topup-check-account.test.ts's "gameId-based
 * multi-provider (Task 9)" describe block one level down the stack (DB reads
 * only, no HTTP route/NicknameService involved) — that file is the proof the
 * extraction didn't change apiTopup.ts's observable behavior; this file is
 * the proof the extracted function itself does what its doc comment claims.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import {
  buildNicknameProviderEntries,
  createGame,
  upsertProviderGameMapping,
  setSetting,
  deleteSetting,
  KOKINPAY_API_KEY_KEY,
  VIPRESELLER_API_ID_KEY,
  VIPRESELLER_API_KEY_KEY,
  MELOSTORE_API_KEY_KEY,
  MELOSTORE_SECRET_KEY_KEY,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  // Not covered by the shared resetDb (added after it was written) — same
  // as games.test.ts.
  await prisma.providerGameMapping.deleteMany();
  await prisma.game.deleteMany();
});

async function makeGame(slug: string) {
  return createGame(prisma, { slug, name: slug });
}

describe("buildNicknameProviderEntries — gameId branch", () => {
  it("returns one entry per enabled mapping, in ascending priority order, each carrying its mapping's gameCode", async () => {
    const game = await makeGame("ml-priority");
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "vipreseller", providerGameCode: "vip-code", priority: 1 });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "kp-code", priority: 0 });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");

    const entries = await buildNicknameProviderEntries(prisma, { gameId: game.id });

    expect(entries.map((e) => [e.provider.id, e.gameCode])).toEqual([
      ["kokinpay", "kp-code"],
      ["vipreseller", "vip-code"],
    ]);
  });

  it("includes a melostore entry when a melostore mapping is enabled and credentialed", async () => {
    const game = await makeGame("ml-melostore");
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "melostore", providerGameCode: "melo-code", priority: 0 });
    await setSetting(prisma, MELOSTORE_API_KEY_KEY, "melo-key");
    await setSetting(prisma, MELOSTORE_SECRET_KEY_KEY, "melo-secret");

    const entries = await buildNicknameProviderEntries(prisma, { gameId: game.id });

    expect(entries.map((e) => [e.provider.id, e.gameCode])).toEqual([["melostore", "melo-code"]]);
  });

  it("excludes a disabled mapping entirely", async () => {
    const game = await makeGame("ml-disabled");
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "kp-code", priority: 0, enabled: false });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    const entries = await buildNicknameProviderEntries(prisma, { gameId: game.id });

    expect(entries).toEqual([]);
  });

  it("skips a mapping whose provider has no credentials configured, without dropping the others", async () => {
    const game = await makeGame("ml-no-creds");
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "kp-code", priority: 0 });
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "vipreseller", providerGameCode: "vip-code", priority: 1 });
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");

    const entries = await buildNicknameProviderEntries(prisma, { gameId: game.id });

    expect(entries.map((e) => e.provider.id)).toEqual(["vipreseller"]);
  });

  it("returns [] when the game has zero ProviderGameMapping rows", async () => {
    const game = await makeGame("ml-empty");
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    expect(await buildNicknameProviderEntries(prisma, { gameId: game.id })).toEqual([]);
  });

  it("returns [] when every enabled mapping's provider is missing credentials", async () => {
    const game = await makeGame("ml-all-uncredentialed");
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "kp-code", priority: 0 });
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);

    expect(await buildNicknameProviderEntries(prisma, { gameId: game.id })).toEqual([]);
  });
});

describe("buildNicknameProviderEntries — legacyGameCode fallback", () => {
  it("returns a single kokinpay entry carrying legacyGameCode when gameId is unset and kokinpay credentials exist", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    const entries = await buildNicknameProviderEntries(prisma, { legacyGameCode: "legacy-code" });

    expect(entries.map((e) => [e.provider.id, e.gameCode])).toEqual([["kokinpay", "legacy-code"]]);
  });

  it("returns [] when gameId is unset, legacyGameCode is set, but no kokinpay credentials are configured", async () => {
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);

    expect(await buildNicknameProviderEntries(prisma, { legacyGameCode: "legacy-code" })).toEqual([]);
  });

  it("returns [] when neither gameId nor legacyGameCode is given", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    expect(await buildNicknameProviderEntries(prisma, {})).toEqual([]);
  });

  it("gameId resolving to at least one entry wins over legacyGameCode — the legacy fallback is never consulted", async () => {
    const game = await makeGame("ml-precedence");
    await upsertProviderGameMapping(prisma, { gameId: game.id, provider: "kokinpay", providerGameCode: "gameid-code", priority: 0 });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    const entries = await buildNicknameProviderEntries(prisma, { gameId: game.id, legacyGameCode: "legacy-code-unused" });

    expect(entries.map((e) => [e.provider.id, e.gameCode])).toEqual([["kokinpay", "gameid-code"]]);
  });

  it("gameId given but resolving to zero entries falls through to legacyGameCode", async () => {
    const game = await makeGame("ml-fallthrough");
    // No ProviderGameMapping rows for this game at all.
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");

    const entries = await buildNicknameProviderEntries(prisma, { gameId: game.id, legacyGameCode: "legacy-fallback-code" });

    expect(entries.map((e) => [e.provider.id, e.gameCode])).toEqual([["kokinpay", "legacy-fallback-code"]]);
  });
});
