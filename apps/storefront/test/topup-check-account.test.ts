// POST /api/v1/topup/check-account — the KokinPay-backed live nickname-check
// lookup wired into InstantBuyPage.tsx's account field. Every non-happy path
// must degrade to `{ available: false }` and never a 5xx/error body — see
// apiTopup.ts's doc comment. Pattern: apps/storefront/test/digiflazz-webhook.test.ts.
//
// Which game (if any) to check is resolved by resolveNicknameGate
// (packages/db/src/crud/nickname.ts): an admin-set per-denomination
// `nicknameCheckGameCode` override wins when present; otherwise the game is
// auto-detected from the product's digiflazzBrand/name against the static
// catalog (@app/core/nickname/gameCatalog). KokinPay is the only nickname-
// check provider — the old gameId/ProviderGameMapping multi-provider branch
// and the VIP-Reseller region-check feature are both gone.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const kokinpayMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayMock.checkGameNickname,
}));

import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting, deleteSetting, createCatalogProduct, createDenomination, KOKINPAY_API_KEY_KEY } from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomWithCheckId: number;
let denomNoCheckId: number;
let denomAutoDetectId: number;

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

  // No nicknameCheckGameCode override — resolveNicknameGate must auto-detect
  // "free-fire" from the product's digiflazzBrand alone.
  const autoDetectProduct = await createCatalogProduct(prisma, {
    categoryId: cat.id,
    name: "Free Fire 100 Diamonds",
    digiflazzBrand: "Free Fire",
  });
  const denomAutoDetect = await createDenomination(prisma, {
    productId: autoDetectProduct.id,
    name: "100 Diamonds",
    type: "SHARED",
    durationLabel: "1x",
    price: "15000",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]),
  });
  denomAutoDetectId = denomAutoDetect.id;

  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(() => {
  kokinpayMock.checkGameNickname.mockReset();
});

describe("POST /api/v1/topup/check-account", () => {
  it("rejects unknown dynamic keys before calling KokinPay", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, player_inputs: { user_id: "123456", callback_url: "https://example.test" } }, "198.51.100.21");
    expect(res.statusCode).toBe(400);
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });
  it("rejects a missing required field despite fake client rules", async () => {
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, player_inputs: {}, requires_zone_id: false, input_config: { required: false } }, "198.51.100.22");
    expect(res.statusCode).toBe(400);
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });
  it("does not call the nickname provider for a disabled service", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    await setSetting(prisma, "service_premium_apps_enabled", "false");
    try {
      const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "123456789" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: false });
      expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
    } finally {
      await deleteSetting(prisma, "service_premium_apps_enabled");
    }
  });

  it("degrades to available:false when the denomination has no nicknameCheckGameCode override and no catalog match", async () => {
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

  it("returns available:true with the resolved nickname on a successful lookup (override game code)", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, player_inputs: { user_id: "123456789" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, valid: true, nickname: "ProPlayer123" });
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith(
      { apiKey: "kp-key" },
      { gameCode: "mobile-legends", id: "123456789", server: undefined },
    );
  });

  it("returns available:true, valid:false for a well-formed not-found lookup", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: false, nickname: null });
    const res = await postCheckAccount({ denomination_id: denomWithCheckId, id: "000000000" });
    expect(res.statusCode).toBe(200);
    // A definitive not-found never carries a `nickname` field — it's only
    // set on the "found" branch (apiTopup.ts).
    expect(res.json()).toEqual({ available: true, valid: false });
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

// Catalog auto-detect (Task 2, replaces the old admin-configured Game/
// ProviderGameMapping tables): no nicknameCheckGameCode override needed —
// the game is detected from the product's digiflazzBrand against the static
// catalog (packages/core/src/nickname/gameCatalog.ts).
describe("POST /api/v1/topup/check-account — unconfigured catalog metadata", () => {
  it("does not infer a nickname service from the display name", async () => {
    await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "AutoDetectedPlayer" });

    const res = await postCheckAccount({ denomination_id: denomAutoDetectId, id: "222333444" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false });
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });
});
