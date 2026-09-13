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
import { logger } from "@app/core/logger";
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

    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
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

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });
});

// ===========================================================================
// nicknameCheckConversation
// ===========================================================================

describe("nicknameCheckConversation", () => {
  it("no zone/server required: found account + Confirm tap stores {target, nickname} on customerData and hands off to confirmation", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ProPlayer123" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "12345678" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "12345678" }),
    );
    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { target: "12345678", nickname: "ProPlayer123" },
    ]);
    expect(confirmTap.session.scratch.pendingNicknameProductId).toBeUndefined();
    expect(confirmTap.session.scratch.pendingNicknameQuantity).toBeUndefined();
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });

  // No static-catalog entry currently has requiresZone:true (see
  // gameCatalog.ts and makeConfiguredDenom's own doc comment) — only
  // requiresServer is exercisable against real catalog data, so this
  // replaces the old requiresZone/requiresZone+requiresServer cases.
  it("requiresServer: prompts target then server, and both end up on customerData", async () => {
    const { denom } = await makeConfiguredDenom({ gameCode: "mobile-legends", withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "ServerPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "111" }).ctx;
    const serverMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "SRV-1" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, serverMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Server")).toBe(true);
    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { target: "111", server: "SRV-1", nickname: "ServerPlayer" },
    ]);
  });

  it("a definitive not-found answer re-prompts the target step, then proceeds once the retry resolves", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname
      .mockResolvedValueOnce({ valid: false, nickname: null }) // -> not_found, definitive: true
      .mockResolvedValueOnce({ valid: true, nickname: "SecondTryPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const badTarget = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "wrong-id" }).ctx;
    const goodTarget = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "right-id" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([badTarget, goodTarget, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Account not found")).toBe(true);
    expect(kokinpayMock.checkGameNickname).toHaveBeenCalledTimes(2);
    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { target: "right-id", nickname: "SecondTryPlayer" },
    ]);
  });

  it("the Retry button after a found result resets the wizard back to the target prompt", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname
      .mockResolvedValueOnce({ valid: true, nickname: "FirstPlayer" })
      .mockResolvedValueOnce({ valid: true, nickname: "SecondPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const firstTarget = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "first-id" }).ctx;
    const retryTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "retry"),
    }).ctx;
    const secondTarget = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "second-id" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([firstTarget, retryTap, secondTarget, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { target: "second-id", nickname: "SecondPlayer" },
    ]);
  });

  it("a non-definitive failure (every configured provider errored) degrades to confirmation without a confirmed nickname — never strands the buyer", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockRejectedValueOnce(new Error("KokinPay network error"));
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "some-id" }).ctx;
    const conv = new FakeConversation([targetMsg]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(JSON.parse(targetMsg.session.scratch.customerData as string)).toEqual([{ target: "some-id" }]);
    expect(targetMsg.session.scratch.pendingNicknameProductId).toBeUndefined();
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });

  it("/cancel abandons the check and re-enters showOrderConfirmation's gate (customerData stays unset)", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const cancelMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/cancel" }).ctx;
    const conv = new FakeConversation([cancelMsg]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(cancelMsg.session.scratch.customerData).toBeUndefined();
    // Re-entering showOrderConfirmation with customerData unset and the game
    // still configured re-triggers this same gate — proven by a fresh
    // conversation.enter("nicknameCheck") call.
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "nicknameCheck")).toBe(true);
    expect(await prisma.order.count()).toBe(0);
  });

  it("tapping the keyboard's Cancel button (routes to v1:buy:) has the same abandon-and-regate effect as /cancel", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const cancelTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const conv = new FakeConversation([cancelTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(cancelTap.session.scratch.customerData).toBeUndefined();
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "nicknameCheck")).toBe(true);
  });

  it("an unrecognized tap on the found/confirm screen answers error.stale_screen and the conversation keeps waiting", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "StaleTestPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "id-1" }).ctx;
    const staleTap = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), callbackData: "v1:menu:main" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, staleTap, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.some((c) => (c.args[0] as { text?: string } | undefined)?.text === t(entry, "error.stale_screen"))).toBe(true);
    // The wizard was unaffected — it kept waiting and completed normally.
    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([{ target: "id-1", nickname: "StaleTestPlayer" }]);
  });

  it("a definitive not-found offers 'Continue anyway', which stores the typed target unverified, reaches confirmation, and emits a diagnostic log (final-review Important #2)", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: false, nickname: null }); // -> not_found, definitive: true
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const badTarget = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "typo-id" }).ctx;
    const continueTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "continue"),
    }).ctx;
    const conv = new FakeConversation([badTarget, continueTap]);
    const infoSpy = vi.spyOn(logger, "info");

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    // Reaches the confirm/pay screen with the last-typed target stored,
    // unverified (no `nickname` field) — never re-loops or dead-ends.
    expect(JSON.parse(continueTap.session.scratch.customerData as string)).toEqual([{ target: "typo-id" }]);
    expect(continueTap.session.scratch.pendingNicknameProductId).toBeUndefined();
    expect(continueTap.session.scratch.pendingNicknameQuantity).toBeUndefined();
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
    // Diagnostic log so an admin can spot a misconfigured providerGameCode —
    // mirrors apiTopup.ts:572-579's logger.info shape.
    expect(
      infoSpy.mock.calls.some(
        ([meta, msg]) =>
          typeof msg === "string" &&
          msg.toLowerCase().includes("not-found") &&
          (meta as Record<string, unknown>)?.productId === denom.id,
      ),
    ).toBe(true);
    infoSpy.mockRestore();
  });

  it("every conversation.external() call returns only JSON-serializable POJOs with no function-typed properties (final-review Important #3)", async () => {
    const { denom } = await makeConfiguredDenom({ withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "PojoPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "pojo-id" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const fake = new FakeConversation([targetMsg, confirmTap]);
    const { conversation, results } = captureExternalResults(fake);

    await nicknameCheckConversation(conversation, entry);

    // Three external() calls in this run: the config resolve, the
    // providersConfigured pre-check, and the checkNickname lookup — every one
    // of them must be a plain value (no NicknameServiceProviderEntry[]
    // closures, no raw Prisma Decimal/Date-carrying rows).
    expect(results.length).toBe(3);
    for (const result of results) {
      assertNoFunctionProps(result);
      expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
    }
  });
});

// ===========================================================================
// Final-review round 2 (money-critical): the write side must key the
// collected answer through the SKU's OWN additionalFields, positionally —
// not the old hardcoded {target,zone,server} shape, which
// buildDigiflazzCustomerNo/computeAccountDiagnosticNote never read (see
// packages/db/src/crud/digiflazz.test.ts for the round-trip proof).
// ===========================================================================

describe("nicknameCheckConversation — keys customerData through the SKU's own additionalFields (final-review round 2)", () => {
  it("a MANUAL_WITH_INFO SKU with 2 additionalFields (requiresServer) maps target/server into the ACTUAL field keys, not {target,server}", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "server_id" }], {
      gameCode: "mobile-legends",
      withCreds: true,
    });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "MappedPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "111222333" }).ctx;
    const serverMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "SRV-7" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, serverMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    // Keyed through the SKU's own additionalFields (user_id/server_id) —
    // NOT the old {target, server} shape.
    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { user_id: "111222333", server_id: "SRV-7", nickname: "MappedPlayer" },
    ]);
  });

  it("quantity > 1 on a MANUAL_WITH_INFO SKU whose additionalFields are NOT fully covered by the mapping hands off to customerInfo WITHOUT a prefilled unit (final-review round 3: field-coverage gate, not quantity, decides the handoff)", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "server_id" }], {
      withCreds: true, // "free-fire" default game code — requiresZone/requiresServer both false, so only 1 of these 2 fields ever gets mapped
    });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "HandoffPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 2 } },
      callbackData: `v1:buy:${denom.id}:2`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "unit-one-id" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    // Does NOT finalize customerData directly, and — since coverage is
    // incomplete — the mapped unit is discarded entirely rather than
    // prefilled: customerInfo re-collects EVERY field from a clean slate.
    expect(confirmTap.session.scratch.customerData).toBeUndefined();
    expect(confirmTap.session.scratch.pendingNicknameProductId).toBeUndefined();
    expect(confirmTap.session.scratch.pendingNicknameQuantity).toBeUndefined();
    expect(confirmTap.session.scratch.pendingInfoProductId).toBe(denom.id);
    expect(confirmTap.session.scratch.pendingInfoQuantity).toBe(2);
    expect(confirmTap.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(true);
  });

  it("quantity === 1 on the SAME under-covered MANUAL_WITH_INFO SKU ALSO hands off to customerInfo instead of finalizing with an incomplete unit (final-review round 3 Critical fix — round 2's `quantity > 1` gate used to let this finalize and permanently strand the buyer at order-creation validation)", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "server_id" }], { withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "SingleUnitPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "single-unit-id" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(confirmTap.session.scratch.customerData).toBeUndefined();
    expect(confirmTap.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
    expect(confirmTap.session.scratch.pendingInfoProductId).toBe(denom.id);
    expect(confirmTap.session.scratch.pendingInfoQuantity).toBe(1);
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(true);
  });

  it("quantity === 1 on a MANUAL_WITH_INFO SKU whose ONLY uncovered field is OPTIONAL still finalizes directly (final-review round 4: coverage counts REQUIRED fields only — validateCustomerData tolerates a blank optional field, so this shape was never actually broken and must not be routed through customerInfo)", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields(
      [
        { key: "user_id", required: true },
        { key: "server_id", required: false },
      ],
      { withCreds: true }, // "free-fire" default game code — requiresZone/requiresServer both false, so server_id is never mapped, but it's optional
    );
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "OptionalGapPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "optional-gap-id" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { user_id: "optional-gap-id", nickname: "OptionalGapPlayer" },
    ]);
    expect(confirmTap.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(false);
  });

  it("quantity === 1 on a MANUAL_WITH_INFO SKU whose additionalFields ARE fully covered by the mapping still finalizes directly (proves the coverage fix didn't overcorrect into always routing through customerInfo)", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "server_id" }], {
      gameCode: "mobile-legends", // requiresZone:false, requiresServer:true -> both fields get mapped
      withCreds: true,
    });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "FullyCoveredPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "full-cov-id" }).ctx;
    const serverMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "SRV-9" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, serverMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    expect(JSON.parse(confirmTap.session.scratch.customerData as string)).toEqual([
      { user_id: "full-cov-id", server_id: "SRV-9", nickname: "FullyCoveredPlayer" },
    ]);
    expect(confirmTap.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(false);
  });

  it("quantity > 1 on a MANUAL_WITH_INFO SKU whose additionalFields ARE fully covered by the mapping still hands off to customerInfo WITH the mapped unit prefilled (round 2's original behavior, unchanged by the round 3 coverage gate)", async () => {
    const denom = await makeConfiguredManualWithInfoDenomWithFields([{ key: "user_id" }, { key: "server_id" }], {
      gameCode: "mobile-legends", // requiresZone:false, requiresServer:true -> both fields get mapped
      withCreds: true,
    });
    kokinpayMock.checkGameNickname.mockResolvedValueOnce({ valid: true, nickname: "FullyCoveredMultiPlayer" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingNicknameProductId: denom.id, pendingNicknameQuantity: 3 } },
      callbackData: `v1:buy:${denom.id}:3`,
    }).ctx;
    const targetMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "full-cov-multi-id" }).ctx;
    const serverMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "SRV-3" }).ctx;
    const confirmTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: ckb.cb("nick", "confirm"),
    }).ctx;
    const conv = new FakeConversation([targetMsg, serverMsg, confirmTap]);

    await nicknameCheckConversation(conv.asMyConversation(), entry);

    // Full coverage + quantity > 1: hands off to customerInfo, but — unlike the
    // under-coverage case above — WITH the collected unit prefilled, since it's
    // a complete, valid unit that customerInfo can safely reuse as unit 1.
    expect(confirmTap.session.scratch.customerData).toBeUndefined();
    expect(confirmTap.session.scratch.pendingInfoProductId).toBe(denom.id);
    expect(confirmTap.session.scratch.pendingInfoQuantity).toBe(3);
    expect(JSON.parse(confirmTap.session.scratch.prefilledCustomerDataUnit as string)).toEqual({
      user_id: "full-cov-multi-id",
      server_id: "SRV-3",
      nickname: "FullyCoveredMultiPlayer",
    });
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(true);
  });
});

// ===========================================================================
// End-to-end: the confirmed nickname threads into Order.customerData exactly
// like customerInfo.ts's manual_with_info answers do (buyNowTokopay is the
// same representative call site customer-info.test.ts uses).
// ===========================================================================

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
    expect(orders[0]!.customerData).toBe(customerData);
    expect(orders[0]!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(ctx.session.scratch.customerData).toBeUndefined();
  });
});
