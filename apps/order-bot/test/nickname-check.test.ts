// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const kokinpayMock = vi.hoisted(() => ({ checkGameNickname: vi.fn() }));
vi.mock("@app/core/suppliers/kokinpay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/kokinpay")>()),
  checkGameNickname: kokinpayMock.checkGameNickname,
}));

vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({
    trxId: "TP-TEST",
    payUrl: null,
    qrLink: "https://x/qr.png",
    qrString: "000",
    totalBayar: "100",
  }),
}));

import {
  prisma,
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  setSetting,
  KOKINPAY_API_KEY_KEY,
} from "@app/db";
import { ProductType, OrderStatus } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import {
  makeCtx,
  FakeConversation,
  calls,
  sentIncludes,
  captureExternalResults,
  assertNoFunctionProps,
  type SentCall,
} from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { t } from "../src/util/i18n";

import * as checkout from "../src/handlers/checkout";
import { nicknameCheckConversation } from "../src/conversations/nicknameCheck";
import * as ckb from "../src/keyboards/customer";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
  kokinpayMock.checkGameNickname.mockReset();
  sample = await buildSampleData(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function userSession(): Partial<SessionData> {
  return {
    lang: "en",
    scratch: {},
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: null,
    },
  };
}

function customerCtx(opts: Parameters<typeof makeCtx>[0] = {}) {
  return makeCtx({ from: { id: 42, username: "tester" }, session: userSession(), ...opts });
}

/**
 * An AUTO SKU (1 stock unit) whose nickname-check is configured via an
 * admin-set `nicknameCheckGameCode` override — a real static-catalog code
 * (@app/core/nickname/gameCatalog) so requiresZone/requiresServer come out
 * of the catalog exactly like production, via resolveNicknameGate's
 * findCatalogEntryByCode lookup. Defaults to "free-fire" (requiresZone:
 * false, requiresServer: false — no extra prompts); pass
 * `gameCode: "mobile-legends"` for a requiresServer:true fixture (no catalog
 * entry has requiresZone:true, so that branch has no real-catalog fixture).
 * `withCreds: true` also sets KokinPay credentials — the minimum for
 * buildNicknameProviderEntries to resolve to an entry, i.e. "actually
 * configured" per the gate's rule.
 */
async function makeConfiguredDenom(opts: { gameCode?: string; withCreds?: boolean } = {}) {
  if (opts.withCreds) await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
  const category = await createCategory(prisma, `game-cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Test Game Top-Up" });
  const denom = await createDenomination(prisma, {
    productId: parentProduct.id,
    name: "100 Diamonds",
    type: ProductType.SHARED,
    durationLabel: "N/A",
    price: "10.00",
    nicknameCheckGameCode: opts.gameCode ?? "free-fire",
    additionalFields: JSON.stringify([
      { key: "target", label: { id: "Player ID", en: "Player ID" }, type: "text", required: true },
      ...(opts.gameCode === "mobile-legends" ? [{ key: "server", label: { id: "Zone ID", en: "Zone ID" }, type: "number", required: true }] : []),
    ]),
  });
  // 5 units — headroom for tests that check quantity > 1 (the stock check
  // runs BEFORE this gate and must never be what's under test here).
  await bulkAddStock(prisma, denom.id, ["s1", "s2", "s3", "s4", "s5"]);
  return { denom, parentProduct };
}

/**
 * A MANUAL_WITH_INFO SKU with its OWN admin-defined additionalFields, fully
 * configured for a live nickname-check (final-review round 2 — the write
 * side must key the collected answer through THESE fields, positionally,
 * not the old hardcoded {target,zone,server} shape). No stock rows needed —
 * manual_with_info never draws from stock.
 */
async function makeConfiguredManualWithInfoDenomWithFields(
  fields: Array<{ key: string; required?: boolean }>,
  opts: { gameCode?: string; withCreds?: boolean } = {},
) {
  if (opts.withCreds) await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
  const category = await createCategory(prisma, `manual-info-fields-cat-${Math.random()}`);
  const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Test Manual-With-Info Fields Game Top-Up" });
  const denom = await createDenomination(prisma, {
    productId: parentProduct.id,
    name: "100 Diamonds",
    type: ProductType.SHARED,
    durationLabel: "N/A",
    price: "10.00",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify(
      fields.map((f) => ({
        key: f.key,
        label: { id: f.key, en: f.key },
        type: "text",
        required: f.required ?? true,
        options: [],
        placeholder: "",
      })),
    ),
    nicknameCheckGameCode: opts.gameCode ?? "free-fire",
  });
  return denom;
}

// ===========================================================================
// showOrderConfirmation — the nickname-check gate. The unconfigured-skip
// cases here are the single most important behavior in this task: nickname
// verification only fires when resolveNicknameGate resolves a gameCode
// (admin override or catalog auto-detect) AND KokinPay credentials are
// configured, and the vast majority of products in this shop have neither —
// the gate must be provably invisible for every one of them.
// ===========================================================================

describe("showOrderConfirmation — nickname-check gate: unconfigured products are unaffected", () => {
  it("a plain AUTO SKU with no override and no catalog-matching brand never enters nicknameCheck (the overwhelming common case)", async () => {
    // sample.product is a bare AUTO SKU from buildSampleData — no
    // nicknameCheckGameCode override, and its name/digiflazzBrand don't
    // match any static-catalog entry. This is the default shape of nearly
    // every product in the shop.
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${sample.product.id}:1` });

    await checkout.showOrderConfirmation(ctx, sample.product.id, 1);

    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });

  it("an override game code is set but no KokinPay credentials are configured: never enters nicknameCheck", async () => {
    const { denom } = await makeConfiguredDenom({ gameCode: "mobile-legends" });
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:1` });

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    expect(calls(sink, "conversation.enter").map((c) => c.args[0])).toEqual(["customerInfo"]);
    expect(sentIncludes(sink, "Confirm Order")).toBe(false);
  });

  it("an unconfigured MANUAL_WITH_INFO SKU is untouched by this gate and still goes through customerInfo (I-6: the nickname gate no longer assumes AUTO, but an unconfigured product's behavior per deliveryType is unchanged)", async () => {
    const category = await createCategory(prisma, `manual-info-cat-${Math.random()}`);
    const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: `Unrelated Manual Info Product ${Math.random()}` });
    const denom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "Manual Info Denom",
      type: ProductType.SHARED,
      durationLabel: "1 Month",
      price: "10.00",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify([
        { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    });
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:1` });

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    const enters = calls(sink, "conversation.enter");
    expect(enters.length).toBe(1);
    expect(enters[0]!.args[0]).toBe("customerInfo");
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// I-6: the nickname-check gate now preempts MANUAL_WITH_INFO too — for a
// product whose game resolves to a gameCode AND KokinPay credentials are
// configured, the live nicknameCheck wizard replaces the customerInfo
// custom-fields wizard entirely, regardless of deliveryType.
// ===========================================================================

describe("showOrderConfirmation — nickname-check gate preempts MANUAL_WITH_INFO's customerInfo wizard (I-6)", () => {
  async function makeConfiguredManualWithInfoDenom(opts: { gameCode?: string; withCreds?: boolean } = {}) {
    if (opts.withCreds) await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
    const category = await createCategory(prisma, `manual-info-nick-cat-${Math.random()}`);
    const parentProduct = await createCatalogProduct(prisma, { categoryId: category.id, name: "Test Manual-With-Info Game Top-Up" });
    const denom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "100 Diamonds",
      type: ProductType.SHARED,
      durationLabel: "N/A",
      price: "10.00",
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify([
        { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
      nicknameCheckGameCode: opts.gameCode ?? "free-fire",
    });
    return denom;
  }

  it("enters nicknameCheck (not customerInfo) for a MANUAL_WITH_INFO SKU whose nickname-check is fully configured", async () => {
    const denom = await makeConfiguredManualWithInfoDenom({ withCreds: true });
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:1` });

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    const enters = calls(sink, "conversation.enter");
    expect(enters.length).toBe(1);
    expect(enters[0]!.args[0]).toBe("nicknameCheck");
    expect(ctx.session.scratch.pendingNicknameProductId).toBe(denom.id);
    expect(sentIncludes(sink, "Confirm Order")).toBe(false);
  });

  it("falls back to customerInfo for a MANUAL_WITH_INFO SKU with a nickname-check override set but no KokinPay credentials configured", async () => {
    const denom = await makeConfiguredManualWithInfoDenom({ gameCode: "mobile-legends", withCreds: false });
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:1` });

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    const enters = calls(sink, "conversation.enter");
    expect(enters.length).toBe(1);
    expect(enters[0]!.args[0]).toBe("customerInfo");
  });
});

describe("showOrderConfirmation — nickname-check gate: configured products divert correctly", () => {
  it("enters the nicknameCheck conversation and stamps pending scratch fields when fully configured", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:2` });

    await checkout.showOrderConfirmation(ctx, denom.id, 2);

    const enters = calls(sink, "conversation.enter");
    expect(enters.length).toBe(1);
    expect(enters[0]!.args[0]).toBe("nicknameCheck");
    expect(ctx.session.scratch.pendingNicknameProductId).toBe(denom.id);
    expect(ctx.session.scratch.pendingNicknameQuantity).toBe(2);
    expect(sentIncludes(sink, "Confirm Order")).toBe(false);
    expect(await prisma.order.count()).toBe(0);
  });

  it("skips the gate once customerData is already set (re-entry guard, same contract as the manual_with_info gate)", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    const existing = JSON.stringify([{ target: "12345", nickname: "AlreadyChecked" }]);
    const { ctx, sink } = customerCtx({
      callbackData: `v1:buy:${denom.id}:1`,
      session: { ...userSession(), scratch: { customerData: existing } },
    });

    const current = await prisma.denomination.findUniqueOrThrow({ where: { id: denom.id } });
    ctx.session.scratch.customerInputOwner = JSON.stringify([denom.id, 1, current.additionalFields, current.providerInputMapping, current.nicknameCheckGameCode]);
    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });
});

// ===========================================================================
// nicknameCheckConversation
// ===========================================================================

describe("nicknameCheckConversation — configured fields", () => {
  async function run(denomId: number, steps: string[], quantity = 1) {
    const sink: SentCall[] = [];
    const session = { ...userSession(), scratch: { pendingNicknameProductId: denomId, pendingNicknameQuantity: quantity } } as SessionData;
    const entry = makeCtx({ sink, sharedSession: session, from: { id: 42 }, callbackData: `v1:buy:${denomId}:${quantity}` }).ctx;
    const queued = steps.map((value) => makeCtx({ sink, sharedSession: session, from: { id: 42 }, ...(value.startsWith("v1:") ? { callbackData: value } : { text: value }) }).ctx);
    const fake = new FakeConversation(queued);
    const captured = captureExternalResults(fake);
    await nicknameCheckConversation(captured.conversation, entry);
    return { sink, session, results: captured.results, entry };
  }

  it("a found single-ID account shows the nickname and stores canonical answers", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["000123", ckb.cb("nick", "confirm")]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "000123" }]);
    expect(sentIncludes(result.sink, "Player")).toBe(true);
    expect(sentIncludes(result.sink, "Confirm Order")).toBe(true);
  });
  it("collects a required zone after Player ID, validating before lookup", async () => {
    const { denom } = await makeConfiguredDenom({ gameCode: "mobile-legends", withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["000123", "invalid", "004", ckb.cb("nick", "confirm")]);
    expect(sentIncludes(result.sink, "Zone ID")).toBe(true);
    expect(sentIncludes(result.sink, "Please enter numbers only")).toBe(true);
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(1);
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith({ apiKey: "kp-key" }, { gameCode: "mobile-legends", id: "000123", server: "004" });
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "000123", server: "004" }]);
  });
  it("does not ask Zone ID for a one-field Delta configuration", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "player_id" }]);
    const result = await run(denom.id, ["000123"]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ player_id: "000123" }]);
    expect(sentIncludes(result.sink, "Zone ID")).toBe(false);
    expect(kokinpayMock.checkGameNickname).not.toHaveBeenCalled();
  });
  it("retries a definitive not-found lookup from fresh fields", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: false, nickname: null }).mockResolvedValueOnce({ valid: true, nickname: "Corrected" });
    const result = await run(denom.id, ["wrong", ckb.cb("nick", "retry"), "correct", ckb.cb("nick", "confirm")]);
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "correct" }]);
  });
  it("Retry after a found result discards prior input", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["first", ckb.cb("nick", "retry"), "second", ckb.cb("nick", "confirm")]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "second" }]);
  });
  it("transient failure proceeds with validated input", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockRejectedValue(new Error("timeout"));
    const result = await run(denom.id, ["target"]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "target" }]);
    expect(sentIncludes(result.sink, "Confirm Order")).toBe(true);
  });
  it.each(["/cancel", "/start", "v1:buy:1:1"])("%s clears incomplete state and exits to the menu", async (escape) => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    const result = await run(denom.id, [escape]);
    expect(result.session.scratch.customerData).toBeUndefined();
    expect(result.session.scratch.pendingInfoProductId).toBeUndefined();
    expect(await prisma.order.count()).toBe(0);
  });
  it("stale confirmation taps are answered and keep waiting", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["target", "v1:unknown", ckb.cb("nick", "confirm")]);
    expect(calls(result.sink, "answerCallbackQuery").some((call) => (call.args[0] as { text?: string } | undefined)?.text === t(result.entry, "error.stale_screen"))).toBe(true);
    expect(result.session.scratch.customerData).toBeDefined();
  });
  it("Continue anyway preserves validated input after a definitive not-found", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: false, nickname: null });
    const result = await run(denom.id, ["target", ckb.cb("nick", "continue")]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "target" }]);
    expect(sentIncludes(result.sink, "Confirm Order")).toBe(true);
  });
  it("all external results are JSON serializable with no function properties", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["target", ckb.cb("nick", "confirm")]);
    expect(result.results.length).toBeGreaterThan(0);
    result.results.forEach((value) => { assertNoFunctionProps(value); expect(() => JSON.stringify(value)).not.toThrow(); });
  });
  it("collects every custom required field before checking an account", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "account" }, { key: "realm" }], { withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["account-id", "realm-value", ckb.cb("nick", "confirm")]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ account: "account-id", realm: "realm-value" }]);
  });
  it.each([1, 2])("collects under-covered schemas fully for quantity %s", async (quantity) => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "zone_id" }], { withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const steps = Array.from({ length: quantity }, (_, i) => [`user-${i}`, `zone-${i}`]).flat();
    const result = await run(denom.id, [...steps, ckb.cb("nick", "confirm")], quantity);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual(Array.from({ length: quantity }, (_, i) => ({ user_id: `user-${i}`, zone_id: `zone-${i}` })));
    expect(result.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
  });
  it("skips optional fields without sending an incomplete unit", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "zone_id", required: false }], { withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["user", ckb.cb("input", "skip", 1), ckb.cb("nick", "confirm")]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ user_id: "user", zone_id: "" }]);
  });
  it.each([1, 2])("collects all units in a fully configured schema, quantity %s", async (quantity) => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "server_id" }], { withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, [...Array.from({ length: quantity }, () => ["user", "server"]).flat(), ckb.cb("nick", "confirm")], quantity);
    expect(JSON.parse(result.session.scratch.customerData as string)).toHaveLength(quantity);
    expect(result.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
  });
  it("Back clears later field values and recollects them", async () => {
    const { denom } = await makeConfiguredDenom({ gameCode: "mobile-legends", withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const result = await run(denom.id, ["old", ckb.cb("input", "back"), "new", "004", ckb.cb("nick", "confirm")]);
    expect(JSON.parse(result.session.scratch.customerData as string)).toEqual([{ target: "new", server: "004" }]);
  });
});

describe("buyNowTokopay — nickname customerData threading", () => {
  it("persists scratch.customerData (target + confirmed nickname) onto the created order", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    const customerData = JSON.stringify([{ target: "GID-999", nickname: "ThreadedPlayer" }]);
    const { ctx } = customerCtx({ session: { ...userSession(), scratch: { customerData } } });

    await checkout.buyNowTokopay(ctx, denom.id, 1);

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders.length).toBe(1);
    expect(orders[0]!.customerData).toBe(JSON.stringify([{ target: "GID-999" }]));
    expect(orders[0]!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(ctx.session.scratch.customerData).toBeUndefined();
  });
});
