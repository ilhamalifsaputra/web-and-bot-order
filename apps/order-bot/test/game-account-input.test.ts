// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * Game Top-up account input in ONE message, and the review screen shown before
 * payment (Phase 3, Task 3). Premium Apps and legacy null-group categories keep
 * the per-field wizard and go straight to the payment screen, exactly as before.
 */
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
  setSetting,
  adjustWallet,
  KOKINPAY_API_KEY_KEY,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
} from "@app/db";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { parseAccountMessage, MAX_GAME_ACCOUNT_UNITS } from "@app/core/accountInput";
import { MAX_LABEL_WIDTH, MAX_LABEL_BYTES, visualWidth } from "@app/core/buttonLimits";
import { DisplayCurrency } from "@app/core/enums";
import { primeQuote } from "./helpers/quote";
import { voucherConversation } from "../src/conversations/checkout";
import { Decimal } from "@app/core/money";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import {
  makeCtx,
  FakeConversation,
  calls,
  sentIncludes,
  lastMarkup,
  captureExternalResults,
  assertNoFunctionProps,
  type SentCall,
} from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { invalidateRateCache, currentUsdtRate } from "../src/util/rate";
import { t, coreT } from "../src/util/i18n";
import { ctxPriceFormatter, esc } from "../src/util/format";
import * as checkout from "../src/handlers/checkout";
import { routeCallback } from "../src/handlers/callbacks";
import { customerInfoConversation, accountExample } from "../src/conversations/customerInfo";
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

function userSession(currency: DisplayCurrency | null = null): Partial<SessionData> {
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
      preferredCurrency: currency,
    },
  };
}

const USER_ID: AdditionalField = {
  key: "user_id",
  label: { id: "ID Pengguna", en: "User ID" },
  type: AdditionalFieldType.NUMBER,
  required: true,
  options: [],
  placeholder: "",
};
const ZONE_ID: AdditionalField = {
  key: "zone_id",
  label: { id: "ID Zona", en: "Zone ID" },
  type: AdditionalFieldType.NUMBER,
  required: true,
  options: [],
  placeholder: "",
};
const PLAYER_TEXT: AdditionalField = {
  key: "player",
  label: { id: "ID Pemain", en: "Player ID" },
  type: AdditionalFieldType.TEXT,
  required: true,
  options: [],
  placeholder: "",
};
const SERVER_SELECT: AdditionalField = {
  key: "server",
  label: { id: "Server", en: "Server" },
  type: AdditionalFieldType.SELECT,
  required: true,
  options: ["Asia", "Europe"],
  placeholder: "",
};

interface DenomOpts {
  /** undefined → GAME_TOPUP; null → a legacy category with no group. */
  group?: string | null;
  gameVariant?: string | null;
  gameRegion?: string | null;
  nicknameCode?: string | null;
  withCreds?: boolean;
  productName?: string;
}

async function makeDenom(fields: AdditionalField[], opts: DenomOpts = {}) {
  if (opts.withCreds) await setSetting(prisma, KOKINPAY_API_KEY_KEY, "kp-key");
  const category = await createCategory(prisma, {
    name: `cat-${Math.random()}`,
    group: opts.group === undefined ? "GAME_TOPUP" : opts.group,
  });
  const product = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: opts.productName ?? "Test Game",
    gameVariant: opts.gameVariant ?? null,
    gameRegion: opts.gameRegion ?? null,
  });
  return createDenomination(prisma, {
    productId: product.id,
    name: "86 Diamonds",
    type: "SHARED",
    durationLabel: "N/A",
    price: "10000",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify(fields),
    nicknameCheckGameCode: opts.nicknameCode ?? null,
  });
}

async function ownerOf(denomId: number, quantity: number): Promise<string> {
  const d = await prisma.denomination.findUniqueOrThrow({ where: { id: denomId } });
  return JSON.stringify([denomId, quantity, d.additionalFields, d.providerInputMapping, d.nicknameCheckGameCode]);
}

/** The Telegram calls that put or change something on the buyer's screen. */
const SCREEN_CALLS = ["sendMessage", "reply", "editMessageText", "editMessageCaption", "deleteMessage", "replyWithPhoto", "sendPhoto", "sendDocument"];
const screenCalls = (sink: SentCall[]) => sink.filter((c) => SCREEN_CALLS.includes(c.method)).map((c) => c.method);

const BUBBLE = 500;

interface Run {
  sink: SentCall[];
  session: SessionData;
  entry: MyContext;
  marks: number[];
  conv: FakeConversation;
}

/**
 * A scripted wizard over ONE shared session, entered from a Buy tap on the
 * bubble `BUBBLE`. Steps are typed text, or `tap:<data>` on the anchored bubble.
 * `marks[i]` is the sink length when step i was handed to the conversation.
 */
function wizardRun(denomId: number, steps: string[], opts: { quantity?: number; currency?: DisplayCurrency | null; nickname?: boolean } = {}): Run {
  const quantity = opts.quantity ?? 1;
  const sink: SentCall[] = [];
  const pending = opts.nickname
    ? { pendingNicknameProductId: denomId, pendingNicknameQuantity: quantity }
    : { pendingInfoProductId: denomId, pendingInfoQuantity: quantity };
  const session = { ...userSession(opts.currency ?? null), menuMsgId: BUBBLE, scratch: { ...pending } } as SessionData;
  const bubble = () => ({ message_id: session.menuMsgId ?? BUBBLE, chat: { id: 42, type: "private" }, date: 0 });
  const entry = makeCtx({ sink, sharedSession: session, from: { id: 42, username: "tester" }, callbackData: `v1:buy:${denomId}:${quantity}`, cbMessage: bubble() }).ctx;
  const marks: number[] = [];
  const queue = steps.map((step) => () => {
    marks.push(sink.length);
    return step.startsWith("tap:")
      ? makeCtx({ sink, sharedSession: session, from: { id: 42, username: "tester" }, callbackData: step.slice(4), cbMessage: bubble() }).ctx
      : makeCtx({ sink, sharedSession: session, from: { id: 42, username: "tester" }, text: step }).ctx;
  });
  return { sink, session, entry, marks, conv: new FakeConversation(queue) };
}

function stepSink(run: Run, i: number): SentCall[] {
  return run.sink.slice(run.marks[i]!, run.marks[i + 1] ?? run.sink.length);
}

/** A tap on the session's anchored bubble, sharing the run's sink and session. */
function tapCtx(run: { sink: SentCall[]; session: SessionData }, data: string): MyContext {
  return makeCtx({
    sink: run.sink,
    sharedSession: run.session,
    from: { id: 42, username: "tester" },
    callbackData: data,
    cbMessage: { message_id: run.session.menuMsgId ?? BUBBLE, chat: { id: 42, type: "private" }, date: 0 },
  }).ctx;
}

const lastEditText = (sink: SentCall[]): string => {
  const edit = calls(sink, "editMessageText").at(-1);
  if (!edit) return "";
  return edit.args.find((a) => typeof a === "string" && a.length > 0 && !/^\d+$/.test(a)) as string;
};

function buttonData(sink: SentCall[]): string[] {
  const kb = lastMarkup(sink)?.inline_keyboard ?? [];
  return kb.flat().map((b) => (b as { callback_data?: string }).callback_data ?? "");
}

const PAY_PREFIXES = ["v1:payq:", "v1:payd:", "v1:payx:", "v1:payb:", "v1:paybc:", "v1:payn:", "v1:walletpay:", "v1:usdt:", "v1:walletm:"];

// ===========================================================================
// Single-message input
// ===========================================================================

describe("Game Top-up: account details in one message", () => {
  it("one message fills every field; the typed message is deleted and the SAME bubble becomes the review (1 delete + 1 edit, no send)", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, ["123456789 1234"]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    // Entry: one prompt for the unit, listing the fields with an example.
    const prompt = run.sink.slice(0, run.marks[0]);
    expect(screenCalls(prompt)).toEqual(["editMessageText"]);
    const promptText = lastEditText(prompt);
    expect(promptText).toContain("User ID + Zone ID");
    expect(promptText).toContain("<code>123456789 1234</code>");
    expect(promptText).toContain(coreT("hint.account_input", "en"));
    expect(promptText).not.toMatch(/[()]/);
    // Single unit: no "Unit 1 of 1" header.
    expect(promptText).not.toContain("Unit 1 of 1");

    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    const review = calls(stepSink(run, 0), "editMessageText")[0]!;
    expect(review.args[1]).toBe(BUBBLE);
    const text = lastEditText(run.sink);
    expect(text).toContain(coreT("checkout.review_title", "en"));
    expect(text).toContain("User ID: <code>123456789</code>");
    expect(text).toContain("Zone ID: <code>1234</code>");
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
    expect(calls(run.sink, "reply")).toHaveLength(0);

    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ user_id: "123456789", zone_id: "1234" }]);
    expect(run.session.scratch.nicknameCheck).toBe("unchecked");
    expect(run.session.scratch.verifiedNickname).toBeUndefined();
    // The review is not a payment screen: no pay button and no stored quote.
    const data = buttonData(run.sink);
    expect(data).toEqual([`v1:rev:go:${denom.id}:1`, `v1:rev:chg:${denom.id}:1`, `v1:browse:denom:${denom.id}`]);
    for (const d of data) for (const p of PAY_PREFIXES) expect(d.startsWith(p)).toBe(false);
    expect(run.session.scratch.quotedTotalIdr).toBeUndefined();
    expect(run.session.scratch.quoteNonce).toBeUndefined();
    expect(run.session.scratch.checkoutIntentId).toBeUndefined();
  });

  it.each([
    ["missing", "abc", () => coreT("checkout.account_err_missing", "en", { label: "Zone ID" })],
    ["too many", "1 2 3", () => coreT("checkout.account_err_too_many", "en")],
    ["ambiguous", "1234567891234", () => coreT("checkout.account_err_ambiguous", "en")],
    ["unbalanced", "123(456", () => coreT("checkout.account_err_unbalanced", "en")],
    ["invalid value", "12a45 1234", () => coreT("checkout.account_err_invalid", "en", { label: "User ID", error: coreT("error.field_invalid_number", "en") })],
  ])("%s: deletes the message and edits the SAME bubble with that error, the example and the error hint (1 delete + 1 edit, no send)", async (_name, bad, expected) => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, [bad, "123456789 1234"]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    const errorStep = stepSink(run, 0);
    expect(screenCalls(errorStep)).toEqual(["deleteMessage", "editMessageText"]);
    const edit = calls(errorStep, "editMessageText")[0]!;
    expect(edit.args[1]).toBe(BUBBLE);
    const text = lastEditText(errorStep);
    expect(text).toContain(expected());
    expect(text).toContain("<code>123456789 1234</code>");
    expect(text).toContain(coreT("hint.account_error", "en"));
    expect(text).not.toContain(coreT("hint.account_input", "en"));
    // Nothing was saved from the refused message.
    expect(screenCalls(stepSink(run, 1))).toEqual(["deleteMessage", "editMessageText"]);
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
    expect(calls(run.sink, "reply")).toHaveLength(0);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ user_id: "123456789", zone_id: "1234" }]);
  });

  it("a stale tap only toasts and keeps waiting; Cancel and /cancel leave without saving anything", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const stale = wizardRun(denom.id, ["tap:v1:menu:main", "123456789 1234"]);
    await customerInfoConversation(stale.conv.asMyConversation(), stale.entry);
    expect(screenCalls(stepSink(stale, 0))).toEqual([]);
    expect((calls(stepSink(stale, 0), "answerCallbackQuery")[0]!.args[0] as { text?: string }).text).toBe(t(stale.entry, "error.stale_screen"));
    expect(JSON.parse(stale.session.scratch.customerData as string)).toEqual([{ user_id: "123456789", zone_id: "1234" }]);

    for (const escape of [`tap:v1:buy:${denom.id}:1`, "/cancel"]) {
      const run = wizardRun(denom.id, [escape]);
      await customerInfoConversation(run.conv.asMyConversation(), run.entry);
      expect(run.session.scratch.customerData).toBeUndefined();
      expect(run.session.scratch.pendingInfoProductId).toBeUndefined();
      expect(sentIncludes(run.sink, coreT("checkout.review_title", "en"))).toBe(false);
    }
    expect(await prisma.order.count()).toBe(0);
  });

  it("the prompt follows the buyer's language", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, ["/cancel"]);
    run.session.lang = "id";
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    const prompt = lastEditText(run.sink.slice(0, run.marks[0]));
    expect(prompt).toContain("ID Pengguna + ID Zona");
    expect(prompt).toContain(coreT("hint.account_input", "id"));
  });

  it("leading zeros and a 24-digit ID reach customerData as the exact strings typed", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const longId = "000123456789012345678901";
    const run = wizardRun(denom.id, [`${longId} 0042`]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    const saved = JSON.parse(run.session.scratch.customerData as string) as Array<Record<string, string>>;
    expect(saved).toEqual([{ user_id: longId, zone_id: "0042" }]);
    expect(typeof saved[0]!.user_id).toBe("string");
    expect(lastEditText(run.sink)).toContain(`User ID: <code>${longId}</code>`);
    expect(lastEditText(run.sink)).toContain("Zone ID: <code>0042</code>");
  });

  it("quantity 2 asks once per unit with a Unit N of M header, and the review lists each unit", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, ["111111 1111", "222222 2222"], { quantity: 2 });

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    expect(lastEditText(run.sink.slice(0, run.marks[0]))).toContain("Unit 1 of 2");
    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(stepSink(run, 0))).toContain("Unit 2 of 2");
    expect(screenCalls(stepSink(run, 1))).toEqual(["deleteMessage", "editMessageText"]);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([
      { user_id: "111111", zone_id: "1111" },
      { user_id: "222222", zone_id: "2222" },
    ]);
    const review = lastEditText(run.sink);
    expect(review).toContain(coreT("checkout.review_qty", "en", { qty: 2 }));
    expect(review).toContain(coreT("checkout.review_unit", "en", { unit: 1 }));
    expect(review).toContain(coreT("checkout.review_unit", "en", { unit: 2 }));
    expect(review.indexOf("111111")).toBeLessThan(review.indexOf("222222"));
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
  });

  it("a single free-text ID keeps accepting what it accepted before, spaces included", async () => {
    const denom = await makeDenom([PLAYER_TEXT]);
    const run = wizardRun(denom.id, ["Night Owl#SEA"]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ player: "Night Owl#SEA" }]);
    expect(lastEditText(run.sink)).toContain(coreT("checkout.review_title", "en"));
  });

  it("a denomination with a select field keeps the per-field wizard, then shows the review", async () => {
    const denom = await makeDenom([PLAYER_TEXT, SERVER_SELECT]);
    const run = wizardRun(denom.id, ["12345", `tap:${ckb.cb("input", "option", 1, 0)}`]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    const first = lastEditText(run.sink.slice(0, run.marks[0]));
    expect(first).toContain(coreT("checkout.info_field_prompt", "en", { unit: 1, total: 1, label: "Player ID" }));
    expect(first).not.toContain(coreT("hint.account_input", "en"));
    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(stepSink(run, 0))).toContain("Server");
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ player: "12345", server: "Asia" }]);
    expect(lastEditText(run.sink)).toContain(coreT("checkout.review_title", "en"));
  });

  it("the example is built from the field specs, has no parentheses and parses back to valid values", () => {
    const fixedZone: AdditionalField = { ...ZONE_ID, minLength: 5, maxLength: 5 };
    expect(accountExample([USER_ID, ZONE_ID])).toBe("123456789 1234");
    expect(accountExample([USER_ID, fixedZone])).toBe("123456789 12345");
    expect(accountExample([{ ...USER_ID, maxLength: 6 }])).toBe("123456");
    const shortMin: AdditionalField = { ...USER_ID, minLength: 12, maxLength: 20 };
    expect(accountExample([shortMin, ZONE_ID])).toBe("123456789012 1234");
    for (const fields of [[USER_ID, ZONE_ID], [USER_ID, fixedZone], [PLAYER_TEXT], [shortMin, ZONE_ID]]) {
      const example = accountExample(fields);
      expect(example).not.toMatch(/[()]/);
      expect(parseAccountMessage(fields, example).ok).toBe(true);
    }
    for (const lang of ["en", "id"]) {
      for (const key of ["hint.account_input", "hint.account_error", "hint.review", "checkout.account_prompt"]) {
        expect(coreT(key, lang)).not.toMatch(/[()]/);
      }
    }
  });
});

// ===========================================================================
// Premium Apps and legacy null-group categories: unchanged
// ===========================================================================

describe("Premium Apps and null-group categories keep today's wizard and payment screen", () => {
  it.each([
    ["PREMIUM_APPS", "PREMIUM_APPS"],
    ["null group", null],
  ] as const)("%s: one prompt per field, then the payment screen, with the same calls as before", async (_name, group) => {
    const denom = await makeDenom([USER_ID, ZONE_ID], { group });
    const run = wizardRun(denom.id, ["123456789", "1234"]);

    await customerInfoConversation(run.conv.asMyConversation(), run.entry);

    const prompt = lastEditText(run.sink.slice(0, run.marks[0]));
    expect(prompt).toContain(coreT("checkout.info_field_prompt", "en", { unit: 1, total: 1, label: "User ID" }));
    expect(prompt).not.toContain(coreT("hint.account_input", "en"));
    expect(screenCalls(run.sink.slice(0, run.marks[0]))).toEqual(["editMessageText"]);
    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(screenCalls(stepSink(run, 1))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(run.sink)).toContain("Confirm Order");
    expect(sentIncludes(run.sink, coreT("checkout.review_title", "en"))).toBe(false);
    expect(sentIncludes(run.sink, "v1:rev:")).toBe(false);
    expect(run.session.scratch.reviewShownFor).toBeUndefined();
    expect(run.session.scratch.nicknameCheck).toBeUndefined();
    expect(typeof run.session.scratch.checkoutIntentId).toBe("string");
    expect(typeof run.session.scratch.quoteNonce).toBe("string");
    expect(calls(run.sink, "sendMessage")).toHaveLength(0);
  });

  it.each([
    ["PREMIUM_APPS", "PREMIUM_APPS"],
    ["null group", null],
  ] as const)("%s: a stored customerData goes straight to the payment screen", async (_name, group) => {
    const denom = await makeDenom([USER_ID], { group });
    const { ctx, sink } = makeCtx({ from: { id: 42 }, session: userSession(), callbackData: `v1:buy:${denom.id}:1` });
    ctx.session.scratch.customerData = JSON.stringify([{ user_id: "12345" }]);
    ctx.session.scratch.customerInputOwner = await ownerOf(denom.id, 1);

    await checkout.showOrderConfirmation(ctx, denom.id, 1);

    expect(screenCalls(sink)).toEqual(["editMessageText"]);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
    expect(sentIncludes(sink, coreT("checkout.review_title", "en"))).toBe(false);
  });
});

// ===========================================================================
// Review content
// ===========================================================================

describe("the review screen", () => {
  async function reviewFor(denomId: number, customerData: Array<Record<string, string>>, opts: { quantity?: number; currency?: DisplayCurrency | null; scratch?: Record<string, unknown> } = {}) {
    const quantity = opts.quantity ?? 1;
    const { ctx, sink } = makeCtx({ from: { id: 42 }, session: userSession(opts.currency ?? null), callbackData: `v1:buy:${denomId}:${quantity}` });
    Object.assign(ctx.session.scratch, opts.scratch ?? {});
    ctx.session.scratch.customerData = JSON.stringify(customerData);
    ctx.session.scratch.customerInputOwner = await ownerOf(denomId, quantity);
    await checkout.showOrderConfirmation(ctx, denomId, quantity);
    return { ctx, sink, text: lastEditText(sink) };
  }

  it("shows game, pack, each field on its own labelled line, the total in IDR, and the hint", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID], { productName: "Mobile Fighters" });
    const { ctx, sink, text } = await reviewFor(denom.id, [{ user_id: "123456789", zone_id: "1234" }]);

    expect(screenCalls(sink)).toEqual(["editMessageText"]);
    expect(text).toContain(coreT("checkout.review_game", "en", { game: "Mobile Fighters" }));
    expect(text).toContain(coreT("checkout.review_pack", "en", { pack: "86 Diamonds" }));
    expect(text).toMatch(/\nUser ID: <code>123456789<\/code>\nZone ID: <code>1234<\/code>\n/);
    const total = ctxPriceFormatter(ctx, await currentUsdtRate()).price(new Decimal("10000"));
    expect(text).toContain(coreT("checkout.review_total", "en", { total }));
    expect(text).toContain(coreT("hint.review", "en"));
    expect(text).not.toContain(coreT("checkout.review_qty", "en", { qty: 1 }));
    expect(text).not.toContain("Edition:");
    expect(text).not.toContain("Region:");
    expect(text).not.toContain("Rp10000");
  });

  it("formats the total for a USD buyer through the same formatter", async () => {
    await setSetting(prisma, "usd_idr_rate", "16000");
    invalidateRateCache();
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const { ctx, text } = await reviewFor(denom.id, [{ user_id: "123456789", zone_id: "1234" }], { currency: DisplayCurrency.USD });
    const total = ctxPriceFormatter(ctx, await currentUsdtRate()).price(new Decimal("10000"));
    expect(total).toContain("$");
    expect(text).toContain(coreT("checkout.review_total", "en", { total }));
  });

  it("shows the edition and region when the product has them and the level was not skipped", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID], { gameVariant: "Umum", gameRegion: "Indonesia" });
    const shown = await reviewFor(denom.id, [{ user_id: "1", zone_id: "2" }]);
    expect(shown.text).toContain(coreT("checkout.review_variant", "en", { variant: "Umum" }));
    expect(shown.text).toContain(coreT("checkout.review_region", "en", { region: "Indonesia" }));

    const skipped = await reviewFor(denom.id, [{ user_id: "1", zone_id: "2" }], { scratch: { gameVariantDimensionSkipped: true, gameRegionDimensionSkipped: true } });
    expect(skipped.text).not.toContain("Umum");
    expect(skipped.text).not.toContain("Indonesia");
  });

  it("escapes every typed value and the nickname", async () => {
    const denom = await makeDenom([PLAYER_TEXT]);
    const { text } = await reviewFor(denom.id, [{ player: "<b>x&y</b>" }], { scratch: { verifiedNickname: "<i>Neo</i>", nicknameCheck: "found" } });
    expect(text).toContain(`Player ID: <code>${esc("<b>x&y</b>")}</code>`);
    expect(text).toContain(coreT("checkout.review_nickname", "en", { nickname: esc("<i>Neo</i>") }));
    expect(text).not.toContain("<b>x&y</b>");
  });

  it("the nickname line: verified, a warning when definitively not found, nothing when unchecked", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const found = await reviewFor(denom.id, [{ user_id: "1", zone_id: "2" }], { scratch: { verifiedNickname: "Player", nicknameCheck: "found" } });
    expect(found.text).toContain(coreT("checkout.review_nickname", "en", { nickname: "Player" }));
    expect(found.text).not.toContain(coreT("checkout.review_not_found", "en"));

    const notFound = await reviewFor(denom.id, [{ user_id: "1", zone_id: "2" }], { scratch: { nicknameCheck: "not_found" } });
    expect(notFound.text).toContain(coreT("checkout.review_not_found", "en"));

    const unchecked = await reviewFor(denom.id, [{ user_id: "1", zone_id: "2" }], { scratch: { nicknameCheck: "unchecked" } });
    expect(unchecked.text).not.toContain("Account:");
    expect(unchecked.text).not.toContain(coreT("checkout.review_not_found", "en"));
  });

  it("buttons: Continue, Change details, Back; every callback fits 64 bytes and every label fits a phone in both languages", () => {
    for (const lang of ["en", "id"]) {
      const kb = ckb.accountReviewKb(2147483647, 999999, lang);
      const buttons = kb.inline_keyboard.flat() as Array<{ text: string; callback_data?: string }>;
      expect(buttons.map((b) => b.callback_data)).toEqual(["v1:rev:go:2147483647:999999", "v1:rev:chg:2147483647:999999", "v1:browse:denom:2147483647"]);
      for (const b of buttons) {
        expect(Buffer.byteLength(b.callback_data!, "utf8")).toBeLessThanOrEqual(64);
        expect(visualWidth(b.text)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
        expect(Buffer.byteLength(b.text, "utf8")).toBeLessThanOrEqual(MAX_LABEL_BYTES);
      }
      expect(kb.inline_keyboard.every((row) => row.length === 1)).toBe(true);
    }
  });
});

// ===========================================================================
// Nickname lookup feeds the review (Game Top-up); no separate confirm screen
// ===========================================================================

describe("Game Top-up nickname lookup goes straight to the review", () => {
  it("found: the typed ID edits the bubble into the review with the account name, no confirm screen", async () => {
    const denom = await makeDenom([PLAYER_TEXT], { nicknameCode: "free-fire", withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: true, nickname: "Player" });
    const run = wizardRun(denom.id, ["000123"], { nickname: true });
    const captured = captureExternalResults(run.conv);

    await nicknameCheckConversation(captured.conversation, run.entry);

    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    const text = lastEditText(run.sink);
    expect(text).toContain(coreT("checkout.review_nickname", "en", { nickname: "Player" }));
    expect(sentIncludes(run.sink, ckb.cb("nick", "confirm"))).toBe(false);
    expect(run.session.scratch.verifiedNickname).toBe("Player");
    expect(run.session.scratch.nicknameCheck).toBe("found");
    // The nickname is display only: never part of the order's account data.
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ player: "000123" }]);
    expect(captured.results.length).toBeGreaterThan(0);
    for (const value of captured.results) {
      assertNoFunctionProps(value);
      expect(() => JSON.stringify(value)).not.toThrow();
    }
  });

  it("definitive not found: the review carries the warning; no Try Again screen", async () => {
    const denom = await makeDenom([PLAYER_TEXT], { nicknameCode: "free-fire", withCreds: true });
    kokinpayMock.checkGameNickname.mockResolvedValue({ valid: false, nickname: null });
    const run = wizardRun(denom.id, ["000123"], { nickname: true });

    await nicknameCheckConversation(run.conv.asMyConversation(), run.entry);

    expect(lastEditText(run.sink)).toContain(coreT("checkout.review_not_found", "en"));
    expect(sentIncludes(run.sink, ckb.cb("nick", "retry"))).toBe(false);
    expect(run.session.scratch.nicknameCheck).toBe("not_found");
    expect(run.session.scratch.verifiedNickname).toBeUndefined();
  });

  it("a failed lookup is unchecked: no nickname line and no warning", async () => {
    const denom = await makeDenom([PLAYER_TEXT], { nicknameCode: "free-fire", withCreds: true });
    kokinpayMock.checkGameNickname.mockRejectedValue(new Error("timeout"));
    const run = wizardRun(denom.id, ["000123"], { nickname: true });

    await nicknameCheckConversation(run.conv.asMyConversation(), run.entry);

    expect(run.session.scratch.nicknameCheck).toBe("unchecked");
    expect(lastEditText(run.sink)).not.toContain(coreT("checkout.review_not_found", "en"));
    expect(lastEditText(run.sink)).toContain(coreT("checkout.review_title", "en"));
  });
});

// ===========================================================================
// Continue / Change details / stale taps
// ===========================================================================

describe("review buttons", () => {
  async function reviewedRun(fields: AdditionalField[] = [USER_ID, ZONE_ID]) {
    const denom = await makeDenom(fields);
    const run = wizardRun(denom.id, ["123456789 1234"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    return { denom, run };
  }

  it("Continue renders the payment screen in the same bubble with a fresh quote, and later screens never go back to the review", async () => {
    // A configured rail, so the payment screen carries a pay button.
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { denom, run } = await reviewedRun();
    const owner = await ownerOf(denom.id, 1);
    const before = run.sink.length;

    await routeCallback(tapCtx(run, `v1:rev:go:${denom.id}:1`));

    const after = run.sink.slice(before);
    expect(screenCalls(after)).toEqual(["editMessageText"]);
    expect(lastEditText(after)).toContain("Confirm Order");
    expect(run.session.scratch.reviewShownFor).toBe(owner);
    expect(typeof run.session.scratch.quoteNonce).toBe("string");
    expect(typeof run.session.scratch.checkoutIntentId).toBe("string");
    expect(buttonData(after).some((d) => d.endsWith(`:${run.session.scratch.quoteNonce as string}`))).toBe(true);

    // Back from the wallet menu, removing a voucher, or Buy again all re-render
    // the payment screen, never the review.
    for (const data of [`v1:walletm:back:${denom.id}:1`, `v1:voucher:remove:${denom.id}:1`, `v1:buy:${denom.id}:1`]) {
      const mark = run.sink.length;
      await routeCallback(tapCtx(run, data));
      expect(lastEditText(run.sink.slice(mark))).toContain("Confirm Order");
      expect(sentIncludes(run.sink.slice(mark), coreT("checkout.review_title", "en"))).toBe(false);
    }
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ user_id: "123456789", zone_id: "1234" }]);
  });

  it("a double tap on Continue renders the payment screen once more and creates no order", async () => {
    const { denom, run } = await reviewedRun();
    await routeCallback(tapCtx(run, `v1:rev:go:${denom.id}:1`));
    const firstNonce = run.session.scratch.quoteNonce;
    const intent = run.session.scratch.checkoutIntentId;
    const mark = run.sink.length;
    await routeCallback(tapCtx(run, `v1:rev:go:${denom.id}:1`));

    expect(screenCalls(run.sink.slice(mark))).toEqual(["editMessageText"]);
    expect(lastEditText(run.sink.slice(mark))).toContain("Confirm Order");
    expect(run.session.scratch.quoteNonce).not.toBe(firstNonce);
    expect(run.session.scratch.checkoutIntentId).toBe(intent);
    expect(await prisma.order.count()).toBe(0);
  });

  it("Change details clears the data, the review state, the quote and the intent id, and asks again in the same bubble", async () => {
    const { denom, run } = await reviewedRun();
    await routeCallback(tapCtx(run, `v1:rev:go:${denom.id}:1`));
    run.session.scratch.verifiedNickname = "Player";
    run.session.scratch.nicknameCheck = "found";
    expect(typeof run.session.scratch.checkoutIntentId).toBe("string");

    const chg = tapCtx(run, `v1:rev:chg:${denom.id}:1`);
    const mark = run.sink.length;
    await routeCallback(chg);

    for (const key of ["customerData", "customerInputOwner", "reviewShownFor", "verifiedNickname", "nicknameCheck", "quotedTotalIdr", "quoteNonce", "quoteFor", "checkoutIntentId"]) {
      expect(run.session.scratch[key], key).toBeUndefined();
    }
    expect(calls(run.sink.slice(mark), "conversation.enter").map((c) => c.args[0])).toEqual(["customerInfo"]);
    expect(run.session.scratch.pendingInfoProductId).toBe(denom.id);
    expect(run.session.scratch.pendingInfoQuantity).toBe(1);

    // The conversation it entered re-prompts by editing the tapped review bubble.
    const conv = new FakeConversation([() => makeCtx({ sink: run.sink, sharedSession: run.session, from: { id: 42 }, text: "987654321 4321" }).ctx]);
    const promptMark = run.sink.length;
    await customerInfoConversation(conv.asMyConversation(), chg);
    const promptCalls = run.sink.slice(promptMark);
    expect(screenCalls(promptCalls)).toEqual(["editMessageText", "deleteMessage", "editMessageText"]);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ user_id: "987654321", zone_id: "4321" }]);
    expect(lastEditText(run.sink)).toContain(coreT("checkout.review_title", "en"));
    expect(run.session.scratch.reviewShownFor).toBeUndefined();
  });

  it("a stale review tap (no data any more, or another quantity) only toasts error.stale_screen", async () => {
    const { denom, run } = await reviewedRun();
    const stale = t(run.entry, "error.stale_screen");

    // Another quantity than the data was entered for.
    let mark = run.sink.length;
    await routeCallback(tapCtx(run, `v1:rev:go:${denom.id}:2`));
    expect(screenCalls(run.sink.slice(mark))).toEqual([]);
    expect(calls(run.sink.slice(mark), "answerCallbackQuery").some((c) => (c.args[0] as { text?: string } | undefined)?.text === stale)).toBe(true);
    expect(run.session.scratch.reviewShownFor).toBeUndefined();

    // The data is gone (e.g. the order was already placed).
    delete run.session.scratch.customerData;
    for (const data of [`v1:rev:go:${denom.id}:1`, `v1:rev:chg:${denom.id}:1`, `v1:rev:zzz:${denom.id}:1`]) {
      mark = run.sink.length;
      await routeCallback(tapCtx(run, data));
      expect(screenCalls(run.sink.slice(mark))).toEqual([]);
      expect(calls(run.sink.slice(mark), "answerCallbackQuery").some((c) => (c.args[0] as { text?: string } | undefined)?.text === stale)).toBe(true);
      expect(calls(run.sink.slice(mark), "conversation.enter")).toHaveLength(0);
    }
    expect(await prisma.order.count()).toBe(0);
  });

  it("a review tap for a Premium Apps denomination is stale", async () => {
    const denom = await makeDenom([USER_ID], { group: "PREMIUM_APPS" });
    const sink: SentCall[] = [];
    const session = { ...userSession(), menuMsgId: BUBBLE } as SessionData;
    session.scratch.customerData = JSON.stringify([{ user_id: "1" }]);
    session.scratch.customerInputOwner = await ownerOf(denom.id, 1);
    await routeCallback(tapCtx({ sink, session }, `v1:rev:go:${denom.id}:1`));
    expect(screenCalls(sink)).toEqual([]);
    expect(session.scratch.reviewShownFor).toBeUndefined();
  });

  it("a changed quantity (owner mismatch) wipes the data and the review state and asks again", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const { ctx, sink } = makeCtx({ from: { id: 42 }, session: userSession(), callbackData: `v1:buy:${denom.id}:2` });
    Object.assign(ctx.session.scratch, {
      customerData: JSON.stringify([{ user_id: "1", zone_id: "2" }]),
      customerInputOwner: await ownerOf(denom.id, 1),
      reviewShownFor: await ownerOf(denom.id, 1),
      verifiedNickname: "Player",
      nicknameCheck: "found",
      checkoutIntentId: "old-intent",
    });

    await checkout.showOrderConfirmation(ctx, denom.id, 2);

    for (const key of ["customerData", "customerInputOwner", "reviewShownFor", "verifiedNickname", "nicknameCheck", "checkoutIntentId"]) {
      expect(ctx.session.scratch[key], key).toBeUndefined();
    }
    expect(calls(sink, "conversation.enter").map((c) => c.args[0])).toEqual(["customerInfo"]);
  });
});

// ===========================================================================
// T3b: review fixes
// ===========================================================================

/** A session holding Game Top-up account data whose review was NOT continued. */
async function unreviewed(denomId: number, units: Array<Record<string, string>>, quantity = 1) {
  const sink: SentCall[] = [];
  const session = { ...userSession(), menuMsgId: BUBBLE } as SessionData;
  session.scratch.customerData = JSON.stringify(units);
  session.scratch.customerInputOwner = await ownerOf(denomId, quantity);
  return { sink, session };
}

function expectReviewWithoutQuote(state: { sink: SentCall[]; session: SessionData }, from = 0) {
  const shown = state.sink.slice(from);
  expect(lastEditText(shown)).toContain(coreT("checkout.review_title", "en"));
  for (const d of buttonData(shown)) for (const p of PAY_PREFIXES) expect(d.startsWith(p), d).toBe(false);
  expect(state.session.scratch.quoteNonce).toBeUndefined();
  expect(state.session.scratch.quotedTotalIdr).toBeUndefined();
  expect(state.session.scratch.quoteFor).toBeUndefined();
}

/** Every tag balanced and every `<`/`&` part of a tag or an entity. */
function expectValidTelegramHtml(html: string) {
  const stack: string[] = [];
  const rest = html.replace(/<(\/?)(b|i|code)>/g, (_m, close: string, tag: string) => {
    if (close) expect(stack.pop()).toBe(tag);
    else stack.push(tag);
    return "";
  });
  expect(stack).toEqual([]);
  expect(rest).not.toMatch(/[<>]/);
  expect(rest.replace(/&(amp|lt|gt|quot|#39);/g, "")).not.toContain("&");
}

describe("T3b I1: every payment render shows the review first", () => {
  it("a USDT tap with unreviewed data renders the review and mints no quote", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const state = await unreviewed(denom.id, [{ user_id: "123456789", zone_id: "1234" }]);
    await routeCallback(tapCtx(state, `v1:usdt:${denom.id}:1`));
    expectReviewWithoutQuote(state);
  });

  it("a stale USDT-rail pay tap with unreviewed data renders the review and mints no quote", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "UID123");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    await setSetting(prisma, "usd_idr_rate", "16000");
    invalidateRateCache();
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const state = await unreviewed(denom.id, [{ user_id: "123456789", zone_id: "1234" }]);
    await routeCallback(tapCtx(state, `v1:payx:${denom.id}:1:abcdef`));
    expectReviewWithoutQuote(state);
    expect(await prisma.order.count()).toBe(0);
  });

  it.each([
    ["the Cancel button", (pid: number) => `tap:v1:buy:${pid}:1`],
    ["/cancel", () => "/cancel"],
    ["an applied voucher", () => "SAVE10"],
  ])("the voucher conversation's exit via %s renders the review and mints no quote", async (_name, step) => {
    // buildSampleData's voucher SAVE10: 10%, minimum purchase 3.
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const state = await unreviewed(denom.id, [{ user_id: "123456789", zone_id: "1234" }]);
    const entry = tapCtx(state, `v1:voucher:start:${denom.id}:1`);
    const s = step(denom.id);
    const next = () => (s.startsWith("tap:") ? tapCtx(state, s.slice(4)) : makeCtx({ sink: state.sink, sharedSession: state.session, from: { id: 42 }, text: s }).ctx);
    await voucherConversation(new FakeConversation([next]).asMyConversation(), entry);
    expectReviewWithoutQuote(state);
  });
});

describe("T3b I2: length budget", () => {
  it("a value over 128 characters is refused in the same bubble, on the parser path and the lone free-text path", async () => {
    const tooLong = coreT("checkout.account_err_invalid", "en", { label: "User ID", error: coreT("error.account_value_too_long", "en", { max: 128 }) });
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, [`${"1".repeat(129)} 1234`, `${"1".repeat(128)} 1234`]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(stepSink(run, 0))).toContain(tooLong);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ user_id: "1".repeat(128), zone_id: "1234" }]);

    const lone = await makeDenom([PLAYER_TEXT]);
    const loneRun = wizardRun(lone.id, [`a b${"x".repeat(130)}`, "Night Owl#SEA"]);
    await customerInfoConversation(loneRun.conv.asMyConversation(), loneRun.entry);
    expect(screenCalls(stepSink(loneRun, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(stepSink(loneRun, 0))).toContain(coreT("checkout.account_err_invalid", "en", { label: "Player ID", error: coreT("error.account_value_too_long", "en", { max: 128 }) }));
    expect(JSON.parse(loneRun.session.scratch.customerData as string)).toEqual([{ player: "Night Owl#SEA" }]);
  });

  it("a 128-character value full of &<> keeps the review HTML valid", async () => {
    const denom = await makeDenom([PLAYER_TEXT]);
    const value = "&<>".repeat(43).slice(0, 128);
    const run = wizardRun(denom.id, [value]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ player: value }]);
    const html = lastEditText(run.sink);
    expect(html).toContain(coreT("checkout.review_title", "en"));
    expectValidTelegramHtml(html);
  });

  it("a review over the budget fails closed: a short message with only Change details and Back, no Continue, no account data", async () => {
    const denom = await makeDenom([PLAYER_TEXT]);
    const units = Array.from({ length: MAX_GAME_ACCOUNT_UNITS }, (_, i) => ({ player: `${i}`.padEnd(128, "&") }));
    const state = await unreviewed(denom.id, units, MAX_GAME_ACCOUNT_UNITS);
    await checkout.showOrderConfirmation(tapCtx(state, `v1:buy:${denom.id}:${MAX_GAME_ACCOUNT_UNITS}`), denom.id, MAX_GAME_ACCOUNT_UNITS);

    expect(screenCalls(state.sink)).toEqual(["editMessageText"]);
    const text = lastEditText(state.sink);
    expect(text).toContain(coreT("checkout.review_too_large", "en"));
    expect(text).not.toContain("&amp;&amp;");
    expect(buttonData(state.sink)).toEqual([`v1:rev:chg:${denom.id}:${MAX_GAME_ACCOUNT_UNITS}`, `v1:browse:denom:${denom.id}`]);
    expect(state.session.scratch.quoteNonce).toBeUndefined();

    // Change details is live on that screen.
    const mark = state.sink.length;
    await routeCallback(tapCtx(state, `v1:rev:chg:${denom.id}:${MAX_GAME_ACCOUNT_UNITS}`));
    expect(calls(state.sink.slice(mark), "conversation.enter").map((c) => c.args[0])).toEqual(["customerInfo"]);
    expect(state.session.scratch.customerData).toBeUndefined();
  });
});

describe("T3b I3 / M1-M6", () => {
  it("I3: quantity above one says only the first unit was checked, for found and not found only", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const units = [{ user_id: "1", zone_id: "2" }, { user_id: "3", zone_id: "4" }];
    for (const [check, qty, shown] of [["found", 2, true], ["not_found", 2, true], ["unchecked", 2, false], ["found", 1, false]] as const) {
      const state = await unreviewed(denom.id, units.slice(0, qty), qty);
      state.session.scratch.nicknameCheck = check;
      if (check === "found") state.session.scratch.verifiedNickname = "Player";
      await checkout.renderAccountReview(tapCtx(state, `v1:buy:${denom.id}:${qty}`), denom.id, qty);
      expect(lastEditText(state.sink).includes(coreT("checkout.review_first_unit_only", "en")), `${check} x${qty}`).toBe(shown);
    }
  });

  it("M1: placing the order clears the review state with the account data", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, ["123456789 1234"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    run.session.scratch.verifiedNickname = "Player";
    run.session.scratch.nicknameCheck = "found";
    await routeCallback(tapCtx(run, `v1:rev:go:${denom.id}:1`));
    await routeCallback(tapCtx(run, `v1:payq:${denom.id}:1:${run.session.scratch.quoteNonce as string}`));
    expect(await prisma.order.count()).toBe(1);
    for (const key of ["customerData", "customerInputOwner", "reviewShownFor", "verifiedNickname", "nicknameCheck"]) {
      expect(run.session.scratch[key], key).toBeUndefined();
    }
  });

  it("M2: an invisible bidi character in a lone free-text value is refused in the same bubble", async () => {
    const denom = await makeDenom([PLAYER_TEXT]);
    const run = wizardRun(denom.id, ["Night‮Owl X", "Night Owl#SEA"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(stepSink(run, 0))).toContain(coreT("checkout.account_err_invalid", "en", { label: "Player ID", error: coreT("error.field_invalid_pattern", "en") }));
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ player: "Night Owl#SEA" }]);
  });

  it("M3: the review explains an applied voucher; Change details drops the voucher and the wallet toggles", async () => {
    // buildSampleData's voucher SAVE10: 10%, minimum purchase 3.
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const state = await unreviewed(denom.id, [{ user_id: "1", zone_id: "2" }]);
    Object.assign(state.session.scratch, { appliedVoucherCode: "SAVE10", useWalletIdr: true });
    const ctx = tapCtx(state, `v1:buy:${denom.id}:1`);
    await checkout.showOrderConfirmation(ctx, denom.id, 1);
    const text = lastEditText(state.sink);
    const prices = ctxPriceFormatter(ctx, await currentUsdtRate());
    expect(text).toContain(coreT("checkout.confirm_voucher_line", "en", { code: "SAVE10", discount: prices.price(new Decimal("1000")) }).trim());
    expect(text).toContain(coreT("checkout.review_total", "en", { total: prices.price(new Decimal("9000")) }));

    await routeCallback(tapCtx(state, `v1:rev:chg:${denom.id}:1`));
    for (const key of ["appliedVoucherCode", "useWalletIdr", "useWalletUsdt", "customerData"]) expect(state.session.scratch[key], key).toBeUndefined();
  });

  it("M4: one field gets the single-value hint, two fields the space hint", async () => {
    const one = await makeDenom([USER_ID]);
    const a = wizardRun(one.id, ["/cancel"]);
    await customerInfoConversation(a.conv.asMyConversation(), a.entry);
    const promptOne = lastEditText(a.sink.slice(0, a.marks[0]));
    expect(promptOne).toContain(coreT("hint.account_input_one", "en"));
    expect(promptOne).not.toContain(coreT("hint.account_input", "en"));

    const two = await makeDenom([USER_ID, ZONE_ID]);
    const b = wizardRun(two.id, ["/cancel"]);
    await customerInfoConversation(b.conv.asMyConversation(), b.entry);
    expect(lastEditText(b.sink.slice(0, b.marks[0]))).toContain(coreT("hint.account_input", "en"));
  });

  it.each(["1e3", "0x10", "12.0", "-1"])("M5: a review callback with a non-decimal id %s is stale and touches nothing", async (bad) => {
    const state = { sink: [] as SentCall[], session: { ...userSession(), menuMsgId: BUBBLE } as SessionData };
    for (const data of [`v1:rev:go:${bad}:1`, `v1:rev:go:1:${bad}`]) {
      const mark = state.sink.length;
      await routeCallback(tapCtx(state, data));
      expect(screenCalls(state.sink.slice(mark))).toEqual([]);
      expect(calls(state.sink.slice(mark), "answerCallbackQuery").some((c) => (c.args[0] as { text?: string } | undefined)?.text === t(makeCtx().ctx, "error.stale_screen"))).toBe(true);
    }
  });

  it("M6: rendering the review retires the pay buttons of the payment screen it replaces", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const state = await unreviewed(denom.id, [{ user_id: "1", zone_id: "2" }]);
    const owner = await ownerOf(denom.id, 1);
    state.session.scratch.reviewShownFor = owner;
    const nonce = await primeQuote(tapCtx(state, `v1:buy:${denom.id}:1`), denom.id, 1);
    expect(typeof nonce).toBe("string");
    delete state.session.scratch.reviewShownFor;

    await checkout.renderAccountReview(tapCtx(state, `v1:buy:${denom.id}:1`), denom.id, 1);
    await routeCallback(tapCtx(state, `v1:payq:${denom.id}:1:${nonce!}`));
    expect(await prisma.order.count()).toBe(0);
    expect(lastEditText(state.sink)).toContain(coreT("checkout.review_title", "en"));
  });

  it("M6: /start and a persistent keyboard label typed at the prompt leave it with the state cleared", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    for (const escape of ["/start", ckb.persistentLabel("orders", "en")]) {
      const run = wizardRun(denom.id, [escape]);
      await customerInfoConversation(run.conv.asMyConversation(), run.entry);
      expect(run.session.scratch.pendingInfoProductId, escape).toBeUndefined();
      expect(run.session.scratch.customerData, escape).toBeUndefined();
      expect(sentIncludes(run.sink, coreT("checkout.review_title", "en"))).toBe(false);
    }
  });

  it("M6: a blank message names the first field as missing", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const run = wizardRun(denom.id, ["   ", "123456789 1234"]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(lastEditText(stepSink(run, 0))).toContain(coreT("checkout.account_err_missing", "en", { label: "User ID" }));
  });

  it("M6: the review body in Indonesian", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const state = await unreviewed(denom.id, [{ user_id: "123456789", zone_id: "1234" }]);
    state.session.lang = "id";
    state.session.scratch.nicknameCheck = "not_found";
    await checkout.showOrderConfirmation(tapCtx(state, `v1:buy:${denom.id}:1`), denom.id, 1);
    const text = lastEditText(state.sink);
    expect(text).toContain(coreT("checkout.review_title", "id"));
    expect(text).toContain("ID Pengguna: <code>123456789</code>");
    expect(text).toContain(coreT("checkout.review_pack", "id", { pack: "86 Diamonds" }));
    expect(text).toContain("⚠️ Akun tidak ditemukan. Cek lagi ID-nya sebelum bayar.");
    expect(text).toContain(coreT("hint.review", "id"));
    const kb = lastMarkup(state.sink)!.inline_keyboard!.flat() as Array<{ text: string }>;
    expect(kb.map((b) => b.text)).toEqual([coreT("checkout.review_continue_btn", "id"), coreT("checkout.review_change_btn", "id"), coreT("menu.back", "id")]);
  });

  it("M7: the Indonesian copy is the reviewed wording", () => {
    expect(coreT("hint.account_input", "id")).toBe("Kirim semua data dalam satu pesan, pisahkan dengan spasi.");
    expect(coreT("hint.account_error", "id")).toBe("Perbaiki, lalu kirim ulang semua data dalam satu pesan.");
    expect(coreT("checkout.account_err_too_many", "id")).toBe("⚠️ Datanya kelebihan. Kirim hanya data yang diminta.");
    expect(coreT("checkout.account_err_ambiguous", "id")).toBe("⚠️ Datanya menempel jadi satu. Pisahkan dengan spasi.");
    expect(coreT("checkout.account_err_unbalanced", "id")).toBe("⚠️ Jangan pakai tanda kurung. Pisahkan data dengan spasi.");
    expect(coreT("checkout.review_not_found", "id")).toBe("⚠️ Akun tidak ditemukan. Cek lagi ID-nya sebelum bayar.");
  });
});

// ===========================================================================
// Follow-up: unit cap for account data, and the 128-character cap per field
// ===========================================================================

describe("MAX_GAME_ACCOUNT_UNITS gate", () => {
  async function gate(denomId: number, quantity: number) {
    const { ctx, sink } = makeCtx({ from: { id: 42 }, session: { ...userSession(), menuMsgId: BUBBLE }, callbackData: `v1:buy:${denomId}:${quantity}`, cbMessage: { message_id: BUBBLE, chat: { id: 42, type: "private" }, date: 0 } });
    await checkout.showOrderConfirmation(ctx, denomId, quantity);
    return { ctx, sink };
  }
  const capText = () => coreT("checkout.account_units_cap", "en", { max: MAX_GAME_ACCOUNT_UNITS });

  it("20 units enter the account wizard", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const { ctx, sink } = await gate(denom.id, MAX_GAME_ACCOUNT_UNITS);
    expect(sentIncludes(sink, capText())).toBe(false);
    expect(ctx.session.scratch.pendingInfoQuantity).toBe(MAX_GAME_ACCOUNT_UNITS);
  });

  it("21 units are refused by editing the bubble once, with a Back-only keyboard to the pack", async () => {
    const denom = await makeDenom([USER_ID, ZONE_ID]);
    const { ctx, sink } = await gate(denom.id, MAX_GAME_ACCOUNT_UNITS + 1);
    expect(screenCalls(sink)).toEqual(["editMessageText"]);
    expect(lastEditText(sink)).toBe(capText());
    expect(buttonData(sink)).toEqual([`v1:browse:denom:${denom.id}`]);
    expect(ctx.session.scratch.pendingInfoProductId).toBeUndefined();
    expect(coreT("checkout.account_units_cap", "id", { max: 20 })).toContain("20");
  });

  it.each([["PREMIUM_APPS", "PREMIUM_APPS"], ["null group", null]] as const)("%s keeps its quantity", async (_n, group) => {
    const denom = await makeDenom([USER_ID], { group });
    const { ctx, sink } = await gate(denom.id, MAX_GAME_ACCOUNT_UNITS + 1);
    expect(sentIncludes(sink, capText())).toBe(false);
    expect(ctx.session.scratch.pendingInfoQuantity).toBe(MAX_GAME_ACCOUNT_UNITS + 1);
  });

  it("a Game Top-up SKU without fields is unaffected", async () => {
    const denom = await makeDenom([]);
    await prisma.denomination.update({ where: { id: denom.id }, data: { additionalFields: null, deliveryType: "auto" } });
    const { sink } = await gate(denom.id, MAX_GAME_ACCOUNT_UNITS + 1);
    expect(sentIncludes(sink, capText())).toBe(false);
  });
});

describe("per-field 128-character cap", () => {
  const OPTIONAL_TEXT: AdditionalField = { ...PLAYER_TEXT, key: "note", label: { id: "Catatan", en: "Note" }, required: false };

  it("Game Top-up: 128 accepted, 129 refused in place with exact counts", async () => {
    const denom = await makeDenom([OPTIONAL_TEXT]);
    const run = wizardRun(denom.id, ["x".repeat(129), "x".repeat(128)]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(screenCalls(stepSink(run, 0))).toEqual(["deleteMessage", "editMessageText"]);
    expect(lastEditText(stepSink(run, 0))).toContain(coreT("error.account_value_too_long", "en", { max: 128 }));
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ note: "x".repeat(128) }]);
  });

  it("Premium Apps accepts 129 characters", async () => {
    const denom = await makeDenom([OPTIONAL_TEXT], { group: "PREMIUM_APPS" });
    const run = wizardRun(denom.id, ["x".repeat(129)]);
    await customerInfoConversation(run.conv.asMyConversation(), run.entry);
    expect(JSON.parse(run.session.scratch.customerData as string)).toEqual([{ note: "x".repeat(129) }]);
  });
});

// ===========================================================================
// Follow-up 8: the input configuration changed between Continue and the pay tap
// ===========================================================================

describe("a pay tap after an admin changed the account input settings", () => {
  const DATA = [{ user_id: "123456789", zone_id: "1234" }];

  /** Game Top-up (or Premium) account data whose review was passed, and the
   *  payment screen rendered from it: the nonce its pay buttons carry. */
  async function paymentScreen(denomId: number, group: "GAME_TOPUP" | "PREMIUM_APPS" = "GAME_TOPUP") {
    const sink: SentCall[] = [];
    const session = { ...userSession(), menuMsgId: BUBBLE } as SessionData;
    const owner = await ownerOf(denomId, 1);
    session.scratch.customerData = JSON.stringify(DATA);
    session.scratch.customerInputOwner = owner;
    if (group === "GAME_TOPUP") session.scratch.reviewShownFor = owner;
    await checkout.showOrderConfirmation(tapCtx({ sink, session }, `v1:buy:${denomId}:1`), denomId, 1);
    expect(lastEditText(sink)).toContain("Confirm Order");
    const nonce = session.scratch.quoteNonce as string;
    expect(nonce).toMatch(/^[0-9a-z]{6}$/);
    return { session, nonce };
  }

  const RAILS = [
    {
      name: "TokoPay",
      callback: "v1:payq",
      scratch: {} as Record<string, unknown>,
      setup: async () => {
        await setSetting(prisma, "tokopay_merchant_id", "M1");
        await setSetting(prisma, "tokopay_secret", "S1");
      },
      pay: (c: MyContext, p: number, n: string) => checkout.buyNowTokopay(c, p, 1, n),
    },
    {
      name: "wallet (IDR credit)",
      callback: "v1:walletpay",
      scratch: { useWalletIdr: true } as Record<string, unknown>,
      setup: async () => {
        await adjustWallet(prisma, sample.user.id, "500000", { currency: "IDR", reason: "admin_adjust" });
      },
      pay: (c: MyContext, p: number, n: string) => checkout.completeOrderWithWallet(c, p, 1, n),
    },
  ];

  const CHANGES = [
    {
      name: "a field relabelled (same keys)",
      apply: (id: number) =>
        prisma.denomination.update({
          where: { id },
          data: { additionalFields: JSON.stringify([{ ...USER_ID, label: { id: "ID Zona", en: "Zone ID" } }, { ...ZONE_ID, label: { id: "ID Pengguna", en: "User ID" } }]) },
        }),
    },
    {
      name: "the provider input mapping changed",
      apply: (id: number) =>
        prisma.denomination.update({ where: { id }, data: { providerInputMapping: JSON.stringify({ digiflazz: { keys: ["zone_id", "user_id"] } }) } }),
    },
  ];

  describe.each(RAILS)("$name", (rail) => {
    beforeEach(async () => {
      await rail.setup();
    });

    it.each(CHANGES)("$name: no order, the data is cleared and asked for again, with only the stale toast on screen", async (change) => {
      const denom = await makeDenom([USER_ID, ZONE_ID]);
      const { session, nonce } = await paymentScreen(denom.id);
      Object.assign(session.scratch, rail.scratch);
      const balanceBefore = (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance;
      await change.apply(denom.id);

      const sink: SentCall[] = [];
      const ctx = tapCtx({ sink, session }, `${rail.callback}:${denom.id}:1:${nonce}`);
      await rail.pay(ctx, denom.id, nonce);

      expect(await prisma.order.count()).toBe(0);
      const balanceAfter = (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance;
      expect(new Decimal(balanceAfter).equals(balanceBefore)).toBe(true);
      for (const key of ["customerData", "customerInputOwner", "reviewShownFor", "quotedTotalIdr", "quoteNonce", "quoteFor", "checkoutIntentId"]) {
        expect(session.scratch[key], key).toBeUndefined();
      }
      // The input is asked for again: the info conversation is entered, and it
      // edits this bubble into the prompt itself.
      expect(calls(sink, "conversation.enter").map((c) => c.args[0])).toEqual(["customerInfo"]);
      expect(session.scratch.pendingInfoProductId).toBe(denom.id);
      expect(screenCalls(sink)).toEqual([]);
      const answers = calls(sink, "answerCallbackQuery");
      expect(answers).toHaveLength(1);
      expect((answers[0]!.args[0] as { text?: string }).text).toBe(t(ctx, "error.stale_screen"));
    });

    it("unchanged settings: the tap pays as before", async () => {
      const denom = await makeDenom([USER_ID, ZONE_ID]);
      const { session, nonce } = await paymentScreen(denom.id);
      Object.assign(session.scratch, rail.scratch);

      const sink: SentCall[] = [];
      await rail.pay(tapCtx({ sink, session }, `${rail.callback}:${denom.id}:1:${nonce}`), denom.id, nonce);

      const orders = await prisma.order.findMany();
      expect(orders).toHaveLength(1);
      expect(orders[0]!.customerData).toBe(JSON.stringify(DATA));
      expect(calls(sink, "conversation.enter")).toHaveLength(0);
    });

    it("a second tap of the button that paid gets only the duplicate alert: no input conversation, nothing on screen", async () => {
      const denom = await makeDenom([USER_ID, ZONE_ID]);
      const { session, nonce } = await paymentScreen(denom.id);
      Object.assign(session.scratch, rail.scratch);
      await rail.pay(tapCtx({ sink: [], session }, `${rail.callback}:${denom.id}:1:${nonce}`), denom.id, nonce);
      expect(await prisma.order.count()).toBe(1);
      const balance = (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance;

      const sink: SentCall[] = [];
      const ctx = tapCtx({ sink, session }, `${rail.callback}:${denom.id}:1:${nonce}`);
      await rail.pay(ctx, denom.id, nonce);

      expect(await prisma.order.count()).toBe(1);
      expect(new Decimal((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance).equals(balance)).toBe(true);
      expect(screenCalls(sink)).toEqual([]);
      expect(calls(sink, "conversation.enter")).toHaveLength(0);
      const answers = calls(sink, "answerCallbackQuery");
      expect(answers.map((c) => c.args[0])).toEqual([{ text: t(ctx, "checkout.duplicate_pending"), show_alert: true }]);
    });

    it.each([
      ["PREMIUM_APPS", "PREMIUM_APPS"],
      ["null group", null],
    ] as const)("%s with unchanged settings: the tap pays as before", async (_name, group) => {
      const denom = await makeDenom([USER_ID, ZONE_ID], { group });
      const { session, nonce } = await paymentScreen(denom.id, "PREMIUM_APPS");
      Object.assign(session.scratch, rail.scratch);

      const sink: SentCall[] = [];
      await rail.pay(tapCtx({ sink, session }, `${rail.callback}:${denom.id}:1:${nonce}`), denom.id, nonce);

      const orders = await prisma.order.findMany();
      expect(orders).toHaveLength(1);
      expect(orders[0]!.customerData).toBe(JSON.stringify(DATA));
    });
  });
});
