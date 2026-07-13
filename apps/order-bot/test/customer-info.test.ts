// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  updateDenomination,
  setSetting,
} from "@app/db";
import { DeliveryType, OrderStatus } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, FakeConversation, calls, sentIncludes, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import * as checkout from "../src/handlers/checkout";
import { customerInfoConversation } from "../src/conversations/customerInfo";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
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

async function makeManualDenom() {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType: DeliveryType.MANUAL });
  return denom;
}

async function makeManualWithInfoDenom(fields: AdditionalField[]) {
  const category = await createCategory(prisma, `manual-info-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Info Product ${Math.random()}` });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Info Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, {
    deliveryType: DeliveryType.MANUAL_WITH_INFO,
    additionalFields: JSON.stringify(fields),
  });
  return denom;
}

const GAME_ID_FIELD: AdditionalField = {
  key: "game_id",
  label: { id: "ID Game", en: "Game ID" },
  type: AdditionalFieldType.TEXT,
  required: true,
  options: [],
  placeholder: "e.g. 123456789",
};

const EMAIL_FIELD: AdditionalField = {
  key: "email",
  label: { id: "Email", en: "Email" },
  type: AdditionalFieldType.EMAIL,
  required: true,
  options: [],
  placeholder: "",
};

// ===========================================================================
// Item 0: pre-existing bug — the unconditional stock check falsely rejected
// every manual/manual_with_info SKU (which by design hold zero stock rows).
// ===========================================================================

describe("showOrderConfirmation — stock-check bug fix (item 0)", () => {
  it("a MANUAL SKU with zero stock rows is NOT falsely rejected as out of stock", async () => {
    const denom = await makeManualDenom();
    expect(await prisma.stockItem.count({ where: { productId: denom.id } })).toBe(0);
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:1` });

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    expect(sentIncludes(sink, "out of stock")).toBe(false);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
    expect(await prisma.order.count()).toBe(0);
  });

  it("an AUTO SKU with genuinely insufficient stock is still correctly rejected (unaffected by the fix)", async () => {
    // sample.product is AUTO with 5 stock rows (buildSampleData) — ask for more than exist.
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${sample.product.id}:99` });
    await checkout.showOrderConfirmation(ctx, sample.product.id, 99);
    expect(sentIncludes(sink, "out of stock")).toBe(true);
    expect(await prisma.order.count()).toBe(0);
  });
});

// ===========================================================================
// The manual_with_info gate in showOrderConfirmation
// ===========================================================================

describe("showOrderConfirmation — manual_with_info info-collection gate", () => {
  it("enters the customerInfo conversation instead of rendering the confirmation when customerData is unset", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:2` });

    await checkout.showOrderConfirmation(ctx, denom.id, 2);

    const enters = calls(sink, "conversation.enter");
    expect(enters.length).toBe(1);
    expect(enters[0]!.args[0]).toBe("customerInfo");
    expect(ctx.session.scratch.pendingInfoProductId).toBe(denom.id);
    expect(ctx.session.scratch.pendingInfoQuantity).toBe(2);
    expect(sentIncludes(sink, "Confirm Order")).toBe(false);
    expect(await prisma.order.count()).toBe(0);
  });

  it("skips the gate and renders the confirmation normally once customerData is already set (e.g. after a quantity change and re-Buy)", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const existing = JSON.stringify([{ game_id: "12345" }]);
    const { ctx, sink } = customerCtx({
      callbackData: `v1:buy:${denom.id}:1`,
      session: { ...userSession(), scratch: { customerData: existing } },
    });

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });

  it("a plain MANUAL SKU (no info step) never enters any conversation", async () => {
    const denom = await makeManualDenom();
    const { ctx, sink } = customerCtx({ callbackData: `v1:buy:${denom.id}:1` });
    await checkout.showOrderConfirmation(ctx, denom.id, 1);
    expect(calls(sink, "conversation.enter").length).toBe(0);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });
});

// ===========================================================================
// customerInfoConversation
// ===========================================================================

describe("customerInfoConversation", () => {
  it("qty=1, single field: collects one answer and hands off to renderOrderConfirmation with customerData set", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const answerMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "GID-777" }).ctx;
    const conv = new FakeConversation([answerMsg]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    expect(JSON.parse(answerMsg.session.scratch.customerData as string)).toEqual([{ game_id: "GID-777" }]);
    expect(answerMsg.session.scratch.pendingInfoProductId).toBeUndefined();
    expect(answerMsg.session.scratch.pendingInfoQuantity).toBeUndefined();
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });

  it("qty=2: prompts the field once per unit with a running 'Unit N of M' header and assembles 2 answer maps", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 2 } },
      callbackData: `v1:buy:${denom.id}:2`,
    }).ctx;
    const unit1 = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "GID-1" }).ctx;
    const unit2 = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "GID-2" }).ctx;
    const conv = new FakeConversation([unit1, unit2]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    expect(JSON.parse(unit2.session.scratch.customerData as string)).toEqual([
      { game_id: "GID-1" },
      { game_id: "GID-2" },
    ]);
    expect(sentIncludes(sink, "Unit 1 of 2")).toBe(true);
    expect(sentIncludes(sink, "Unit 2 of 2")).toBe(true);
  });

  it("re-prompts the SAME field on a validation error, then proceeds once the retry is valid", async () => {
    const denom = await makeManualWithInfoDenom([EMAIL_FIELD]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const badAnswer = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "not-an-email" }).ctx;
    const goodAnswer = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "buyer@example.com" }).ctx;
    const conv = new FakeConversation([badAnswer, goodAnswer]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Please enter a valid email address.")).toBe(true);
    expect(JSON.parse(goodAnswer.session.scratch.customerData as string)).toEqual([{ email: "buyer@example.com" }]);
  });

  it("/cancel abandons info-collection and re-enters showOrderConfirmation's gate (customerData stays unset — no infinite loop, a fresh Buy tap re-triggers the wizard)", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const cancelMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "/cancel" }).ctx;
    const conv = new FakeConversation([cancelMsg]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    expect(cancelMsg.session.scratch.customerData).toBeUndefined();
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(true);
    expect(await prisma.order.count()).toBe(0);
  });

  it("tapping the keyboard's Cancel button (routes to v1:buy:) has the same abandon-and-regate effect as /cancel", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const cancelTap = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: userSession(),
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const conv = new FakeConversation([cancelTap]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    expect(cancelTap.session.scratch.customerData).toBeUndefined();
    expect(calls(sink, "conversation.enter").some((c) => c.args[0] === "customerInfo")).toBe(true);
  });

  it("defends against a manual_with_info SKU with no configured fields by going straight to renderOrderConfirmation", async () => {
    const denom = await makeManualWithInfoDenom([]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const conv = new FakeConversation([]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
  });
});

// ===========================================================================
// Threading customerData through order creation (representative call site —
// createOrderDirect-direct shape; the createInternalOrder/createBybitOrder/
// createBybitBscOrder wrapper shape is covered at the crud level in
// binance-internal.test.ts / bybit-deposit.test.ts / bybit-bsc-deposit.test.ts,
// and the wallet shape in packages/db/src/crud/wallet_checkout.test.ts).
// ===========================================================================

describe("buyNowTokopay — customerData threading", () => {
  it("persists scratch.customerData onto the created order and clears it from scratch only on success", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const customerData = JSON.stringify([{ game_id: "GID-999" }]);
    const { ctx } = customerCtx({ session: { ...userSession(), scratch: { customerData } } });

    await checkout.buyNowTokopay(ctx, denom.id, 1);

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders.length).toBe(1);
    expect(orders[0]!.customerData).toBe(customerData);
    expect(orders[0]!.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(ctx.session.scratch.customerData).toBeUndefined();
  });

  it("auto/manual checkout (no manual_with_info step) never sets scratch.customerData, so it stays null on the created order", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    // sample.product is AUTO — the ordinary path, no gate ever fires.
    const { ctx } = customerCtx();
    await checkout.buyNowTokopay(ctx, sample.product.id, 1);

    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders.length).toBe(1);
    expect(orders[0]!.customerData).toBeNull();
  });
});
