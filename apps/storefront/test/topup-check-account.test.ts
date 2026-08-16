// POST /api/v1/topup/check-account (Task 7, final task of the Digiflazz
// top-up pilot) — the KokinPay-backed live nickname-check lookup wired into
// InstantBuyPage.tsx's account field. Every non-happy path must degrade to
// `{ available: false }` and never a 5xx/error body — see apiTopup.ts's
// doc comment. Pattern: apps/storefront/test/digiflazz-webhook.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const kokinpayMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayMock.checkGameNickname,
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
  KOKINPAY_API_KEY_KEY,
} from "@app/db";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let denomWithCheckId: number;
let denomNoCheckId: number;

async function postCheckAccount(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/v1/topup/check-account", payload: body });
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
