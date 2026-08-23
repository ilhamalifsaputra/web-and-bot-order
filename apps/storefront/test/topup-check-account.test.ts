// POST /api/v1/topup/check-account (Task 7, final task of the Digiflazz
// top-up pilot) — the KokinPay-backed live nickname-check lookup wired into
// InstantBuyPage.tsx's account field. Every non-happy path must degrade to
// `{ available: false }` and never a 5xx/error body — see apiTopup.ts's
// doc comment. Pattern: apps/storefront/test/digiflazz-webhook.test.ts.
//
// Region-check Task C added a second, fully independent block (VIP-Reseller
// region-check, `region_mismatch`) on this same endpoint — see the
// "region-check (Task C)" describe block below for its dedicated cases,
// including the independence tests in both directions.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const kokinpayMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayMock.checkGameNickname,
}));

const vipResellerMock = vi.hoisted(() => ({ checkGameRegion: vi.fn(), checkNicknameViaVipReseller: vi.fn() }));
vi.mock("@app/core/suppliers/vipreseller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/vipreseller")>()),
  checkGameRegion: vipResellerMock.checkGameRegion,
  checkNicknameViaVipReseller: vipResellerMock.checkNicknameViaVipReseller,
}));

// Task 9 (multi-provider nickname check): MeloStore is a brand-new supplier
// only ever reached through the gameId branch, never the legacy KokinPay-only
// block — mocked the same way as the two suppliers above.
const melostoreMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/melostore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/melostore")>()),
  checkGameNickname: melostoreMock.checkGameNickname,
}));

import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  createGame,
  upsertProviderGameMapping,
  KOKINPAY_API_KEY_KEY,
  VIPRESELLER_API_ID_KEY,
  VIPRESELLER_API_KEY_KEY,
  MELOSTORE_API_KEY_KEY,
  MELOSTORE_SECRET_KEY_KEY,
} from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomWithCheckId: number;
let denomNoCheckId: number;
let denomWithRegionId: number;

async function postCheckAccount(body: Record<string, unknown>, ip?: string) {
  return app.inject({ method: "POST", url: "/api/v1/topup/check-account", payload: body, remoteAddress: ip });
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({ data: { name: "TopupCat", slug: "topup-cat", sortOrder: 1 } });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Nickname Check Test Product" });

  const denomWithCheck = await createDenomination(prisma, {
    productId: product.id,
    name: "Nickname Check Test Product",
    type: "SHARED",
    durationLabel: "1x",
    price: "15000",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]),
    nicknameCheckGameCode: "mobile-legends",
  });
  denomWithCheckId = denomWithCheck.id;

  const denomNoCheck = await createDenomination(prisma, {
    productId: product.id,
    name: "No Nickname Check",
    type: "SHARED",
    durationLabel: "1x",
    price: "15000",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]),
  });
  denomNoCheckId = denomNoCheck.id;

  const denomWithRegion = await createDenomination(prisma, {
    productId: product.id,
    name: "Region Check Test Product",
    type: "SHARED",
    durationLabel: "1x",
    price: "15000",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]),
    nicknameCheckGameCode: "mobile-legends",
    expectedRegionCode: "id",
  });
  denomWithRegionId = denomWithRegion.id;

  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(() => {
  kokinpayMock.checkGameNickname.mockReset();
  vipResellerMock.checkGameRegion.mockReset();
  vipResellerMock.checkNicknameViaVipReseller.mockReset();
  melostoreMock.checkGameNickname.mockReset();
});

describe("POST /api/v1/topup/check-account", () => {
  it("degrades to available:false when the denomination has no nicknameCheckGameCode configured", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const res = await postCheckAccount({ denomination_id: denomNoCheckId, id: "123456789" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });

  it("degrades to available:false when no KokinPay credentials are configured", async () => {
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "123456789" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });

  it("returns available:true with the resolved nickname on a successful lookup", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "123456789", server: "1234" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "mobile-legends", id: "123456789", server: "1234" },
    );
  });

  it("returns available:true, valid:false for a well-formed not-found lookup", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: false, nickname: null });
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "000000000" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: false, nickname: null });
  });

  it("degrades to available:false (never a 5xx) when the KokinPay client itself throws", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockRejectedValueOnce(new Error("KokinPay check-nickname network error"));
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "123456789" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it("degrades to available:false for malformed input instead of erroring", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const res = await postCheckAccount({ denomination_id: "not-a-number", id: "123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it("degrades to available:false for a non-existent denomination", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const res = await postCheckAccount({ denomination_id: 9999999, id: "123" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });
});

// Region-check Task C: the VIP-Reseller-backed region-check block, fully
// independent of the KokinPay nickname-check block above. Every test here
// explicitly sets/deletes all three relevant settings (KokinPay creds,
// VIP-Reseller api_id/api_key) rather than relying on state left over from
// another test, since both credential stores persist across `it` blocks in
// this file.
describe("POST /api/v1/topup/check-account — region-check (Task C)", () => {
  it("region match: no region_mismatch key in the response", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });
    // Case-insensitive match against the fixture's expectedRegionCode "id".
    vipResellerMock.checkGameRegion.mockResolvedValueOnce({ countryCode: "ID" });

    const res = await postCheckAccount({ denomination_id: denomWithRegionId, id: "123456789" }, "10.0.1.1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
    expect(vipResellerMock.checkGameRegion).toHaveBeenCalledWith(
      { apiId: "vip-id", apiKey: "vip-key" },
      { gameCode: "mobile-legends", id: "123456789", server: undefined },
    );
  });

  it("region mismatch: region_mismatch:true in the response", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });
    vipResellerMock.checkGameRegion.mockResolvedValueOnce({ countryCode: "US" });

    const res = await postCheckAccount({ denomination_id: denomWithRegionId, id: "123456789" }, "10.0.1.2");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123", region_mismatch: true });
  });

  it("no expectedRegionCode configured: VIP-Reseller is never called, no region_mismatch key", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });

    const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "123456789" }, "10.0.1.3");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
    expect(vipResellerMock.checkGameRegion).not.toHaveBeenCalled();
  });

  it("no VIP-Reseller credentials configured: silent degrade, no region_mismatch key", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await deleteSetting(prisma, VIPRESELLER_API_ID_KEY);
    await deleteSetting(prisma, VIPRESELLER_API_KEY_KEY);
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });

    const res = await postCheckAccount({ denomination_id: denomWithRegionId, id: "123456789" }, "10.0.1.4");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
    expect(vipResellerMock.checkGameRegion).not.toHaveBeenCalled();
  });

  it("VIP-Reseller throws: silent degrade, no region_mismatch key (never a 5xx)", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });
    vipResellerMock.checkGameRegion.mockRejectedValueOnce(new Error("VIP-Reseller game-feature HTTP 500"));

    const res = await postCheckAccount({ denomination_id: denomWithRegionId, id: "123456789" }, "10.0.1.5");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
  });

  it("independence: KokinPay credentials missing but VIP-Reseller succeeds — nickname part stays available:false, region part still works", async () => {
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    vipResellerMock.checkGameRegion.mockResolvedValueOnce({ countryCode: "US" });

    const res = await postCheckAccount({ denomination_id: denomWithRegionId, id: "123456789" }, "10.0.1.6");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, region_mismatch: true });
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });

  it("independence (reverse): KokinPay succeeds, VIP-Reseller has no credentials — nickname part unaffected", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await deleteSetting(prisma, VIPRESELLER_API_ID_KEY);
    await deleteSetting(prisma, VIPRESELLER_API_KEY_KEY);
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });

    const res = await postCheckAccount({ denomination_id: denomWithRegionId, id: "123456789" }, "10.0.1.7");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
    expect(vipResellerMock.checkGameRegion).not.toHaveBeenCalled();
  });
});

// Task 9 (nickname-multiprovider plan): the gameId-driven NicknameService
// branch. Every case here builds its OWN Game + Product(gameId) + Denomination
// via makeGameDenomination below, so ProviderGameMapping rows/priorities from
// one test never leak into another — only the credential Settings are shared/
// reset explicitly per test, matching this file's existing convention (see
// the region-check describe block's own comment on that).
//
// The pre-existing "gameId is null, legacy nicknameCheckGameCode is set"
// case is NOT re-tested here: the top describe block's "returns available:true
// with the resolved nickname on a successful lookup" test already exercises
// exactly that path (denomWithCheckId has no Game link at all), and the
// restructure in apiTopup.ts kept that block byte-identical — confirmed by
// the fact that all 14 pre-existing tests in this file still pass unmodified
// against the restructured handler.
describe("POST /api/v1/topup/check-account — gameId-based multi-provider (Task 9)", () => {
  let categoryId: number;
  let gameCounter = 0;

  beforeAll(async () => {
    const cat = await prisma.category.create({ data: { name: "Task9Cat", slug: "task9-cat", sortOrder: 1 } });
    categoryId = cat.id;
  });

  async function makeGameDenomination(opts?: {
    nicknameCheckGameCode?: string | null;
    expectedRegionCode?: string | null;
  }) {
    gameCounter += 1;
    const game = await createGame(prisma, { slug: `task9-game-${gameCounter}`, name: `Task9 Game ${gameCounter}` });
    const product = await createCatalogProduct(prisma, { categoryId, name: `Task9 Product ${gameCounter}` });
    await prisma.product.update({ where: { id: product.id }, data: { gameId: game.id } });
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: `Task9 Denom ${gameCounter}`,
      type: "SHARED",
      durationLabel: "1x",
      price: "15000",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify([
        {
          key: "user_id",
          label: { id: "Game ID", en: "Game ID" },
          type: "text",
          required: true,
          options: [],
          placeholder: "",
        },
      ]),
      nicknameCheckGameCode: opts?.nicknameCheckGameCode ?? undefined,
      expectedRegionCode: opts?.expectedRegionCode ?? undefined,
    });
    return { gameId: game.id, denominationId: denom.id };
  }

  it("one enabled kokinpay mapping, provider returns a nickname", async () => {
    const { gameId, denominationId } = await makeGameDenomination();
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "kp-code",
      enabled: true,
      priority: 0,
    });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "MultiProviderPlayer" });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "111" }, "10.0.9.1");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "MultiProviderPlayer" });
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "kp-code", id: "111", server: undefined },
    );
  });

  it("two enabled mappings by priority: priority-0 fails with a retryable network error, priority-1 succeeds (fallback works)", async () => {
    const { gameId, denominationId } = await makeGameDenomination();
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "kp-code-fallback",
      enabled: true,
      priority: 0,
    });
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "vipreseller",
      providerGameCode: "vip-code-fallback",
      enabled: true,
      priority: 1,
    });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockRejectedValueOnce(new Error("KokinPay check-nickname network error"));
    vipResellerMock.checkNicknameViaVipReseller.mockResolvedValueOnce({ nickname: "FallbackPlayer" });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "222" }, "10.0.9.2");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "FallbackPlayer" });
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(vipResellerMock.checkNicknameViaVipReseller).toHaveBeenCalledWith(
      { apiId: "vip-id", apiKey: "vip-key" },
      { gameCode: "vip-code-fallback", id: "222", server: undefined },
    );
  });

  it("priority-0 returns a definitive not-found outcome: response is available:false and priority-1 is never called", async () => {
    const { gameId, denominationId } = await makeGameDenomination();
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "kp-code-definitive",
      enabled: true,
      priority: 0,
    });
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "vipreseller",
      providerGameCode: "vip-code-definitive",
      enabled: true,
      priority: 1,
    });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    // A well-formed "not found" result — kokinpayProvider.ts maps this to the
    // non-retryable INVALID_TARGET, so NicknameService stops here.
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: false, nickname: null });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "333" }, "10.0.9.3");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
    expect(vipResellerMock.checkNicknameViaVipReseller).not.toHaveBeenCalled();
  });

  it("a disabled mapping is excluded from the attempt entirely", async () => {
    const { gameId, denominationId } = await makeGameDenomination();
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "vipreseller",
      providerGameCode: "vip-code-disabled",
      enabled: false,
      priority: 0,
    });
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "kp-code-enabled",
      enabled: true,
      priority: 1,
    });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "EnabledOnlyPlayer" });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "444" }, "10.0.9.4");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "EnabledOnlyPlayer" });
    expect(vipResellerMock.checkNicknameViaVipReseller).not.toHaveBeenCalled();
  });

  it("zero ProviderGameMapping rows for the game: available:false, no throw", async () => {
    const { denominationId } = await makeGameDenomination();
    const res = await postCheckAccount({ denomination_id: denominationId, id: "555" }, "10.0.9.5");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
  });

  it("a mapping's credentials are not configured: that mapping is skipped, falls through to the next one", async () => {
    const { gameId, denominationId } = await makeGameDenomination();
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "kp-code-no-creds",
      enabled: true,
      priority: 0,
    });
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "vipreseller",
      providerGameCode: "vip-code-has-creds",
      enabled: true,
      priority: 1,
    });
    await deleteSetting(prisma, KOKINPAY_API_KEY_KEY);
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    vipResellerMock.checkNicknameViaVipReseller.mockResolvedValueOnce({ nickname: "SkippedToNextPlayer" });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "666" }, "10.0.9.6");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "SkippedToNextPlayer" });
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });

  it("gameId AND legacy nicknameCheckGameCode both set: the gameId path is used, the legacy KokinPay call is never made", async () => {
    const { gameId, denominationId } = await makeGameDenomination({
      nicknameCheckGameCode: "legacy-code-should-not-run",
    });
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "gameid-path-code",
      enabled: true,
      priority: 0,
    });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "GameIdPathPlayer" });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "777" }, "10.0.9.7");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "GameIdPathPlayer" });
    // Called exactly once, with the MAPPING's game code — if the legacy
    // block had ALSO run, this mock (shared by both code paths) would have
    // been called a second time with "legacy-code-should-not-run" instead.
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "gameid-path-code", id: "777", server: undefined },
    );
  });

  it("region-check still runs independently off the legacy game code even when gameId is also set", async () => {
    const { gameId, denominationId } = await makeGameDenomination({
      nicknameCheckGameCode: "legacy-code-for-region",
      expectedRegionCode: "id",
    });
    await upsertProviderGameMapping(prisma, {
      gameId,
      provider: "kokinpay",
      providerGameCode: "gameid-path-code-region",
      enabled: true,
      priority: 0,
    });
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, VIPRESELLER_API_ID_KEY, "vip-id");
    await setSetting(prisma, VIPRESELLER_API_KEY_KEY, "vip-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "RegionPathPlayer" });
    vipResellerMock.checkGameRegion.mockResolvedValueOnce({ countryCode: "US" });

    const res = await postCheckAccount({ denomination_id: denominationId, id: "888" }, "10.0.9.8");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: true,
      valid: true,
      nickname: "RegionPathPlayer",
      region_mismatch: true,
    });
    // The nickname-check side went through the gameId/mapping path (its own
    // game code)...
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "gameid-path-code-region", id: "888", server: undefined },
    );
    // ...while the region-check ran independently, off the LEGACY game code,
    // exactly as it does with no gameId at all (see the region-check describe
    // block above).
    expect(vipResellerMock.checkGameRegion).toHaveBeenCalledWith(
      { apiId: "vip-id", apiKey: "vip-key" },
      { gameCode: "legacy-code-for-region", id: "888", server: undefined },
    );
  });
});
