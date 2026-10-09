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
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
} from "@app/db";
import { DeliveryType, OrderStatus } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, FakeConversation, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { t } from "../src/util/i18n";
import * as checkout from "../src/handlers/checkout";
import { customerInfoConversation } from "../src/conversations/customerInfo";
import * as ckb from "../src/keyboards/customer";

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
      preferredCurrency: null,
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

  it("skips the gate and renders the confirmation normally once customerData belongs to this SKU, quantity and configuration", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const existing = JSON.stringify([{ game_id: "12345" }]);
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

  it("/cancel abandons info-collection and clears state and returns to the main menu", async () => {
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
    expect(calls(sink, "conversation.enter")).toHaveLength(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it("tapping the keyboard's Cancel button (routes to v1:buy:) has the same clean cancellation effect as /cancel", async () => {
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
    expect(calls(sink, "conversation.enter")).toHaveLength(0);
  });

  it("an unrecognized tap during the wait answers error.stale_screen and the conversation keeps waiting (M-22 fix)", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: { ...userSession(), scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } },
      callbackData: `v1:buy:${denom.id}:1`,
    }).ctx;
    const staleTap = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), callbackData: "v1:menu:main" }).ctx;
    const answerMsg = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "GID-777" }).ctx;
    const conv = new FakeConversation([staleTap, answerMsg]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    const answers = calls(sink, "answerCallbackQuery");
    expect(answers.some((c) => (c.args[0] as { text?: string } | undefined)?.text === t(entry, "error.stale_screen"))).toBe(true);
    // Conversation was unaffected — it kept waiting and completed normally.
    expect(JSON.parse(answerMsg.session.scratch.customerData as string)).toEqual([{ game_id: "GID-777" }]);
  });

  it("resumes at unit index 1 (not 0) when scratch.prefilledCustomerDataUnit is seeded (nicknameCheck.ts's multi-unit handoff, final-review round 2)", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const prefilled = JSON.stringify({ game_id: "FROM-NICKNAME-CHECK" });
    const sink: SentCall[] = [];
    const entry = makeCtx({
      sink,
      from: { id: 42, username: "tester" },
      session: {
        ...userSession(),
        scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 2, prefilledCustomerDataUnit: prefilled },
      },
      callbackData: `v1:buy:${denom.id}:2`,
    }).ctx;
    const unit2 = makeCtx({ sink, from: { id: 42, username: "tester" }, session: userSession(), text: "GID-2" }).ctx;
    const conv = new FakeConversation([unit2]);

    await customerInfoConversation(conv.asMyConversation(), entry);

    // Starts straight at "Unit 2 of 2" — the prefilled unit already satisfied
    // unit 1, so it's never re-prompted.
    expect(sentIncludes(sink, "Unit 1 of 2")).toBe(false);
    expect(sentIncludes(sink, "Unit 2 of 2")).toBe(true);
    expect(JSON.parse(unit2.session.scratch.customerData as string)).toEqual([
      { game_id: "FROM-NICKNAME-CHECK" },
      { game_id: "GID-2" },
    ]);
    expect(entry.session.scratch.prefilledCustomerDataUnit).toBeUndefined();
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
// One wizard bubble: Game ID → Zone → order summary → QR, with the exact
// Telegram calls each step makes (message budget, AGENTS.md).
// ===========================================================================

const ZONE_FIELD: AdditionalField = {
  key: "zone_id",
  label: { id: "Zone ID", en: "Zone ID" },
  type: AdditionalFieldType.TEXT,
  required: true,
  options: [],
  placeholder: "",
};
const OPTIONAL_ZONE_FIELD: AdditionalField = { ...ZONE_FIELD, required: false };

/** The Telegram calls that put or change something on the buyer's screen. */
const SCREEN_CALLS = ["sendMessage", "reply", "editMessageText", "editMessageCaption", "deleteMessage", "replyWithPhoto", "sendPhoto", "sendDocument"];
const screenCalls = (sink: SentCall[], from = 0) => sink.slice(from).filter((c) => SCREEN_CALLS.includes(c.method)).map((c) => c.method);

const WIZARD_BUBBLE = 500;

/**
 * A scripted wizard over ONE shared session, started from a Buy tap on the
 * order bubble `WIZARD_BUBBLE`. Steps are typed text, or `tap:<data>` — a tap
 * on the bubble the session currently anchors (that is where the wizard's
 * buttons live). `marks` records the sink length when each step is handed to
 * the conversation, so a test can read what every single step sent.
 */
function wizardRun(denomId: number, steps: string[], opts: { failDeleteOnStep?: number } = {}) {
  const sink: SentCall[] = [];
  const session = {
    ...userSession(),
    menuMsgId: WIZARD_BUBBLE,
    scratch: { pendingInfoProductId: denomId, pendingInfoQuantity: 1 },
  } as SessionData;
  const bubble = () => ({ message_id: session.menuMsgId ?? WIZARD_BUBBLE, chat: { id: 42, type: "private" }, date: 0 });
  const entry = makeCtx({ sink, sharedSession: session, from: { id: 42, username: "tester" }, callbackData: `v1:buy:${denomId}:1`, cbMessage: bubble() }).ctx;
  const marks: number[] = [];
  const queue = steps.map((step, i) => () => {
    marks.push(sink.length);
    const c = step.startsWith("tap:")
      ? makeCtx({ sink, sharedSession: session, from: { id: 42, username: "tester" }, callbackData: step.slice(4), cbMessage: bubble() }).ctx
      : makeCtx({ sink, sharedSession: session, from: { id: 42, username: "tester" }, text: step }).ctx;
    if (opts.failDeleteOnStep === i) {
      (c.api as unknown as { deleteMessage: () => Promise<never> }).deleteMessage = () => Promise.reject(new Error("message can't be deleted"));
    }
    return c;
  });
  return { sink, session, entry, marks, conv: new FakeConversation(queue) };
}

function stepCalls(run: { sink: SentCall[]; marks: number[] }, i: number): string[] {
  const end = run.marks[i + 1] ?? run.sink.length;
  return run.sink.slice(run.marks[i]!, end).filter((c) => SCREEN_CALLS.includes(c.method)).map((c) => c.method);
}

function skipButtonOffered(sink: SentCall[]): boolean {
  return JSON.stringify(lastMarkup(sink) ?? {}).includes(ckb.cb("input", "skip", 1));
}

describe("single-bubble checkout wizard — exact Telegram call counts", () => {
  it("Game ID → Zone → summary edits ONE bubble; the typed answers are deleted; the summary is never a new message", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD, ZONE_FIELD]);
    const run = wizardRun(denom.id, ["GID-1", "Z-1"]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    // Entry (Buy tap): the Game ID prompt edits the tapped bubble in place.
    expect(screenCalls(run.sink.slice(0, run.marks[0]))).toEqual(["editMessageText"]);
    // Game ID typed: the answer is deleted, the Zone prompt edits the same bubble.
    expect(stepCalls(run, 0)).toEqual(["deleteMessage", "editMessageText"]);
    // Zone typed: deleted, and the order summary EDITS the wizard bubble.
    expect(stepCalls(run, 1)).toEqual(["deleteMessage", "editMessageText"]);
    const summary = calls(run.sink, "editMessageText").at(-1)!;
    expect(summary.args[1]).toBe(WIZARD_BUBBLE);
    expect(JSON.stringify(summary.args)).toContain("Confirm Order");
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
    expect(calls(run.sink, "reply")).toHaveLength(0);
    expect(calls(run.sink, "editMessageCaption")).toHaveLength(0);
    expect(run.session.menuMsgId).toBe(WIZARD_BUBBLE);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ game_id: "GID-1", zone_id: "Z-1" }]);
  });

  it("the summary falls back to ONE new message only when the wizard bubble is gone, and anchors it", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const sink: SentCall[] = [];
    const session = { ...userSession(), menuMsgId: WIZARD_BUBBLE, scratch: { pendingInfoProductId: denom.id, pendingInfoQuantity: 1 } } as SessionData;
    const entry = makeCtx({ sink, sharedSession: session, callbackData: `v1:buy:${denom.id}:1`, cbMessage: { message_id: WIZARD_BUBBLE, chat: { id: 42, type: "private" }, date: 0 } }).ctx;
    // The buyer deleted the wizard bubble before typing the answer.
    const typed = makeCtx({ sink, sharedSession: session, text: "GID-1", deletedMessageIds: [WIZARD_BUBBLE] }).ctx;

    await customerInfoConversation(new FakeConversation([typed]).asMyConversation(), entry);

    expect(calls(sink, "reply")).toHaveLength(1);
    expect(calls(sink, "sendMessage")).toHaveLength(0);
    expect(sentIncludes(calls(sink, "reply"), "Confirm Order")).toBe(true);
    expect(session.menuMsgId).not.toBe(WIZARD_BUBBLE);
    expect(session.menuMsgId).toBeDefined();
  });

  it("a required zone offers no Skip button; an optional zone does, and Skip edits straight to the summary", async () => {
    const required = await makeManualWithInfoDenom([GAME_ID_FIELD, ZONE_FIELD]);
    const req = wizardRun(required.id, ["GID-1", "/cancel"]);
    await customerInfoConversation(req.conv.asMyConversation(), req.entry);
    // The last screen before /cancel is the Zone prompt.
    const zonePromptReq = req.sink.slice(0, req.marks[1]);
    expect(sentIncludes(zonePromptReq, "Zone ID")).toBe(true);
    expect(skipButtonOffered(zonePromptReq)).toBe(false);

    const optional = await makeManualWithInfoDenom([GAME_ID_FIELD, OPTIONAL_ZONE_FIELD]);
    const opt = wizardRun(optional.id, ["GID-1", `tap:${ckb.cb("input", "skip", 1)}`]);
    await customerInfoConversation(opt.conv.asMyConversation(), opt.entry);
    expect(skipButtonOffered(opt.sink.slice(0, opt.marks[1]))).toBe(true);
    // Skip tap: answered, and the summary edits the tapped wizard bubble.
    expect(stepCalls(opt, 1)).toEqual(["editMessageText"]);
    expect(JSON.stringify(calls(opt.sink, "editMessageText").at(-1)!.args)).toContain("Confirm Order");
    expect(calls(opt.sink, "sendMessage")).toHaveLength(0);
    expect(calls(opt.sink, "reply")).toHaveLength(0);
    expect(JSON.parse(opt.session.scratch.customerData as string)).toEqual([{ game_id: "GID-1", zone_id: "" }]);
  });

  it("no zone field: the step is bypassed and the Game ID answer goes straight to the summary edit", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const run = wizardRun(denom.id, ["GID-1"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(sentIncludes(run.sink, "Zone ID")).toBe(false);
    expect(stepCalls(run, 0)).toEqual(["deleteMessage", "editMessageText"]);
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
  });

  it("an invalid answer re-renders the SAME bubble with the error and deletes the typed input", async () => {
    const denom = await makeManualWithInfoDenom([EMAIL_FIELD]);
    const run = wizardRun(denom.id, ["not-an-email", "buyer@example.com"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    expect(stepCalls(run, 0)).toEqual(["deleteMessage", "editMessageText"]);
    const errorEdit = run.sink.slice(run.marks[0], run.marks[1]).find((c) => c.method === "editMessageText")!;
    expect(errorEdit.args[1]).toBe(WIZARD_BUBBLE);
    expect(JSON.stringify(errorEdit.args)).toContain("Please enter a valid email address.");
    expect(stepCalls(run, 1)).toEqual(["deleteMessage", "editMessageText"]);
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
    expect(calls(run.sink, "reply")).toHaveLength(0);
  });

  it("a failed delete of the typed answer is tolerated: the value is still saved and the wizard advances in the same bubble", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD, ZONE_FIELD]);
    const run = wizardRun(denom.id, ["GID-1", "Z-1"], { failDeleteOnStep: 0 });
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    expect(stepCalls(run, 0)).toEqual(["editMessageText"]);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ game_id: "GID-1", zone_id: "Z-1" }]);
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
    expect(calls(run.sink, "reply")).toHaveLength(0);
  });

  it("a stale tap after the wizard advanced only toasts error.stale_screen — no edit, no send, no state change", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD, OPTIONAL_ZONE_FIELD]);
    // Field 0's (now superseded) Skip button, tapped while the Zone prompt shows.
    const run = wizardRun(denom.id, ["GID-1", `tap:${ckb.cb("input", "skip", 0)}`, "Z-1"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    expect(stepCalls(run, 1)).toEqual([]);
    const staleAnswer = run.sink.slice(run.marks[1], run.marks[2]).filter((c) => c.method === "answerCallbackQuery");
    expect(staleAnswer).toHaveLength(1);
    expect((staleAnswer[0]!.args[0] as { text?: string }).text).toBe(t(run.entry, "error.stale_screen"));
    // The Zone step was still waiting: the next answer lands in zone_id.
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ game_id: "GID-1", zone_id: "Z-1" }]);
  });

  it("Back re-renders the previous prompt in the same bubble; Cancel leaves the wizard", async () => {
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD, ZONE_FIELD]);
    const run = wizardRun(denom.id, ["OLD", `tap:${ckb.cb("input", "back")}`, "NEW", "Z-1"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(stepCalls(run, 1)).toEqual(["editMessageText"]);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ game_id: "NEW", zone_id: "Z-1" }]);
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
    expect(calls(run.sink, "reply")).toHaveLength(0);

    const cancel = wizardRun(denom.id, ["GID-1", `tap:v1:buy:${denom.id}:1`]);
    await customerInfoConversation(cancel.conv.asMyConversation(), cancel.entry);
    expect(cancel.session.scratch.customerData).toBeUndefined();
    expect(cancel.session.scratch.pendingInfoProductId).toBeUndefined();
    expect(await prisma.order.count()).toBe(0);
  });

  it("the QR that follows the summary is the only new message, and the summary bubble is deleted right after it", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD, ZONE_FIELD]);
    const run = wizardRun(denom.id, ["GID-1", "Z-1"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    const before = run.sink.length;
    const railTap = makeCtx({
      sink: run.sink,
      sharedSession: run.session,
      callbackData: `v1:payq:${denom.id}:1`,
      cbMessage: { message_id: run.session.menuMsgId!, chat: { id: 42, type: "private" }, date: 0 },
      replyWithPhotoResult: { photo: [{ file_id: "qr" }] },
    }).ctx;
    await checkout.buyNowTokopay(railTap, denom.id, 1);

    expect(screenCalls(run.sink, before)).toEqual(["replyWithPhoto", "deleteMessage"]);
    expect(calls(run.sink.slice(before), "deleteMessage")[0]!.args[1]).toBe(WIZARD_BUBBLE);
    const order = await prisma.order.findFirstOrThrow({ where: { userId: sample.user.id } });
    const anchor = await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } });
    expect(anchor?.messageId).toBe(run.session.menuMsgId);
    expect(anchor?.messageKind).toBe("photo");
  });
});

describe("checkoutIntentId on the wizard path", () => {
  it("an order placed after the wizard carries a checkoutIntentId, and a duplicate tap with that intent creates no second order", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, BINANCE_UID_KEY, "UID123");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    await setSetting(prisma, "usd_idr_rate", "16000");
    const denom = await makeManualWithInfoDenom([GAME_ID_FIELD]);
    const run = wizardRun(denom.id, ["GID-1"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    const intent = run.session.scratch.checkoutIntentId;
    expect(typeof intent).toBe("string");
    // A second tap racing the first reads the same session snapshot (same
    // intent). It goes to a DIFFERENT rail so the per-rail duplicate pre-check
    // cannot be what refuses it — only the atomic intent guard can.
    const staleScratch = { ...run.session.scratch };

    const first = makeCtx({ sharedSession: run.session, callbackData: `v1:payq:${denom.id}:1` }).ctx;
    await checkout.buyNowTokopay(first, denom.id, 1);
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.checkoutIntentId).toBe(intent);

    const { ctx: second, sink } = customerCtx({ callbackData: `v1:payx:${denom.id}:1`, session: { ...userSession(), scratch: staleScratch } });
    await checkout.buyNowInternal(second, denom.id, 1);
    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(1);
    expect(sentIncludes(sink, t(second, "checkout.duplicate_pending"))).toBe(true);
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
