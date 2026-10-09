// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({
    trxId: "TP-TOPUP-TEST",
    payUrl: null,
    qrLink: "https://x/qr.png",
    qrString: "000",
    totalBayar: "100",
  }),
}));

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prisma,
  setSetting,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
} from "@app/db";
import { OrderKind, PaymentMethod } from "@app/core/enums";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, lastMarkup, type SentCall } from "./helpers/ctx";
import type { SessionData } from "../src/context";
import { invalidateRateCache } from "../src/util/rate";
import { topupMethodsKb } from "../src/keyboards/customer";
import * as walletTopup from "../src/handlers/walletTopup";
import { routeCallback } from "../src/handlers/callbacks";

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

// ===========================================================================
// topupMethodsKb — mirrors payment-menu.test.ts's coverage of usdtMethodsKb/
// orderConfirmKb: only the gateways actually enabled for the chosen currency
// get a button.
// ===========================================================================

interface FlatBtn {
  text: string;
  callback_data?: string;
}

function data(kb: { inline_keyboard: FlatBtn[][] }): string[] {
  return kb.inline_keyboard.flat().map((b) => b.callback_data ?? "");
}

describe("topupMethodsKb", () => {
  it("IDR: shows TokoPay + PayDisini when both are enabled, never a USDT rail", () => {
    const d = data(topupMethodsKb("IDR", "en", true, true, true, true, true, true));
    expect(d).toContain("v1:topup:pay:tokopay");
    expect(d).toContain("v1:topup:pay:paydisini");
    expect(d.some((x) => x.startsWith("v1:topup:pay:internal"))).toBe(false);
    expect(d.some((x) => x.startsWith("v1:topup:pay:bybit"))).toBe(false);
    expect(d.some((x) => x.startsWith("v1:topup:pay:nowpayments"))).toBe(false);
  });

  it("IDR: omits a rail's button when it isn't enabled", () => {
    const onlyTokopay = data(topupMethodsKb("IDR", "en", true, false));
    expect(onlyTokopay).toContain("v1:topup:pay:tokopay");
    expect(onlyTokopay).not.toContain("v1:topup:pay:paydisini");

    const onlyPaydisini = data(topupMethodsKb("IDR", "en", false, true));
    expect(onlyPaydisini).not.toContain("v1:topup:pay:tokopay");
    expect(onlyPaydisini).toContain("v1:topup:pay:paydisini");

    const neither = data(topupMethodsKb("IDR", "en", false, false));
    expect(neither.some((x) => x.startsWith("v1:topup:pay:"))).toBe(false);
  });

  it("USDT: shows Binance/Bybit/Bybit BSC/NOWPayments only when each is enabled, never an IDR rail", () => {
    const all = data(topupMethodsKb("USDT", "en", true, true, true, true, true, true));
    expect(all).toContain("v1:topup:pay:internal");
    expect(all).toContain("v1:topup:pay:bybit");
    expect(all).toContain("v1:topup:pay:bybitbsc");
    expect(all).toContain("v1:topup:pay:nowpayments");
    expect(all.some((x) => x.startsWith("v1:topup:pay:tokopay"))).toBe(false);
    expect(all.some((x) => x.startsWith("v1:topup:pay:paydisini"))).toBe(false);

    const none = data(topupMethodsKb("USDT", "en", false, false, false, false, false, false));
    expect(none.some((x) => x.startsWith("v1:topup:pay:"))).toBe(false);
  });

  it("USDT: omits NOWPayments alone when only it is disabled", () => {
    const d = data(topupMethodsKb("USDT", "en", false, false, true, true, true, false));
    expect(d).toContain("v1:topup:pay:internal");
    expect(d).toContain("v1:topup:pay:bybit");
    expect(d).toContain("v1:topup:pay:bybitbsc");
    expect(d.some((x) => x.startsWith("v1:topup:pay:nowpayments"))).toBe(false);
  });

  it("always offers a Back action re-opening the amount prompt for the same currency", () => {
    const idr = data(topupMethodsKb("IDR", "en"));
    expect(idr).toContain("v1:topup:currency:idr");
    const usdt = data(topupMethodsKb("USDT", "en"));
    expect(usdt).toContain("v1:topup:currency:usdt");
  });
});

// ===========================================================================
// topup domain dispatch — v1:topup:* routes to the right walletTopup export.
// ===========================================================================

describe("topup callback domain dispatch", () => {
  it("v1:topup:open routes to showWalletTopupMenu (currency choice screen)", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:topup:open" });
    await routeCallback(ctx);
    const flat = JSON.stringify(sink);
    expect(flat).toContain("v1:topup:currency:idr");
    expect(flat).toContain("v1:topup:currency:usdt");
  });

  it("v1:topup:currency:idr routes to promptTopupAmount(ctx, \"IDR\") — sets the IDR capture flag and prompts for an amount", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:topup:currency:idr" });
    await routeCallback(ctx);
    expect(ctx.session.awaitingTopupCurrency).toBe("IDR");
    expect(JSON.stringify(sink)).toContain("IDR");
  });

  it("v1:topup:currency:usdt routes to promptTopupAmount(ctx, \"USDT\") — sets the USDT capture flag", async () => {
    const { ctx } = customerCtx({ callbackData: "v1:topup:currency:usdt" });
    await routeCallback(ctx);
    expect(ctx.session.awaitingTopupCurrency).toBe("USDT");
  });

  it.each([
    ["tokopay", "payTopupTokopay"],
    ["paydisini", "payTopupPaydisini"],
    ["internal", "payTopupInternal"],
    ["bybit", "payTopupBybit"],
    ["bybitbsc", "payTopupBybitBsc"],
    ["nowpayments", "payTopupNowpayments"],
  ] as const)("v1:topup:pay:%s routes to walletTopup.%s and no other pay handler", async (rail, fnName) => {
    const spies = {
      payTopupTokopay: vi.spyOn(walletTopup, "payTopupTokopay").mockResolvedValue(undefined),
      payTopupPaydisini: vi.spyOn(walletTopup, "payTopupPaydisini").mockResolvedValue(undefined),
      payTopupInternal: vi.spyOn(walletTopup, "payTopupInternal").mockResolvedValue(undefined),
      payTopupBybit: vi.spyOn(walletTopup, "payTopupBybit").mockResolvedValue(undefined),
      payTopupBybitBsc: vi.spyOn(walletTopup, "payTopupBybitBsc").mockResolvedValue(undefined),
      payTopupNowpayments: vi.spyOn(walletTopup, "payTopupNowpayments").mockResolvedValue(undefined),
    };
    try {
      const { ctx } = customerCtx({ callbackData: `v1:topup:pay:${rail}` });
      await routeCallback(ctx);
      for (const [name, spy] of Object.entries(spies)) {
        if (name === fnName) expect(spy, `${name} should have been called`).toHaveBeenCalledTimes(1);
        else expect(spy, `${name} should NOT have been called`).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  });

  it("an unknown v1:topup:pay:<rail> is a no-op (not routed to any handler)", async () => {
    const spy = vi.spyOn(walletTopup, "payTopupTokopay").mockResolvedValue(undefined);
    try {
      const { ctx } = customerCtx({ callbackData: "v1:topup:pay:doesnotexist" });
      await routeCallback(ctx);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ===========================================================================
// End-to-end smoke: a couple of representative rails actually create a
// WALLET_TOPUP order via createWalletTopupOrder, reusing the real gateway-
// claim/QR-render/anchoring code (not a fresh reimplementation).
// ===========================================================================

describe("payTopup* handlers (representative rails)", () => {
  it("payTopupTokopay creates an IDR/TOKOPAY WALLET_TOPUP order and sends the QR as one photo+caption bubble", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { ctx, sink } = customerCtx({
      session: { ...userSession(), scratch: { topupCurrency: "IDR", topupAmount: "50000" } },
    });
    await walletTopup.payTopupTokopay(ctx);

    const order = await prisma.order.findFirst({ where: { userId: sample.user.id }, orderBy: { id: "desc" } });
    expect(order?.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order?.paymentMethod).toBe(PaymentMethod.TOKOPAY);
    expect(order?.currency).toBe("IDR");
    // Bare order — no OrderItem rows on a WALLET_TOPUP order (it credits the
    // wallet balance directly, not a SKU).
    const itemCount = await prisma.orderItem.count({ where: { orderId: order!.id } });
    expect(itemCount).toBe(0);
    expect(calls(sink, "replyWithPhoto").length).toBe(1);
  });

  it("payTopupInternal creates a USDT/BINANCE_INTERNAL WALLET_TOPUP order with a paymentRef, no HTTP call needed", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "UID123");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    await setSetting(prisma, "usd_idr_rate", "16000");
    const { ctx, sink } = customerCtx({
      session: { ...userSession(), scratch: { topupCurrency: "USDT", topupAmount: "10" } },
    });
    await walletTopup.payTopupInternal(ctx);

    const order = await prisma.order.findFirst({ where: { userId: sample.user.id }, orderBy: { id: "desc" } });
    expect(order?.kind).toBe(OrderKind.WALLET_TOPUP);
    expect(order?.paymentMethod).toBe(PaymentMethod.BINANCE_INTERNAL);
    expect(order?.currency).toBe("USDT");
    expect(order?.paymentRef).toBeTruthy();
    expect(JSON.stringify(sink)).toContain("UID123");

    // Pin the actual call-site wiring, not just the message body: the
    // real screen's reply_markup must carry native copy-to-clipboard
    // buttons for the Binance UID and the unique payment code, not merely
    // mention them in the caption text (which the assertion above already
    // covered before copy buttons existed).
    const markup = lastMarkup(sink) as
      | { inline_keyboard?: Array<Array<{ copy_text?: { text: string } }>> }
      | undefined;
    const copies = (markup?.inline_keyboard ?? []).flat().map((b) => b.copy_text?.text);
    expect(copies).toContain("UID123");
    expect(copies).toContain(order!.paymentRef);
  });

  it("payTopupInternal clears the scratch amount/currency once the order is created", async () => {
    await setSetting(prisma, BINANCE_UID_KEY, "UID123");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    await setSetting(prisma, "usd_idr_rate", "16000");
    const { ctx } = customerCtx({
      session: { ...userSession(), scratch: { topupCurrency: "USDT", topupAmount: "10" } },
    });
    await walletTopup.payTopupInternal(ctx);
    const scratch = ctx.session.scratch as { topupCurrency?: string; topupAmount?: string };
    expect(scratch.topupCurrency).toBeUndefined();
    expect(scratch.topupAmount).toBeUndefined();
  });

  it("a stale tap (no scratch amount/currency) never crashes — falls back to the currency-choice screen", async () => {
    const { ctx, sink } = customerCtx({ callbackData: "v1:topup:pay:internal" });
    await walletTopup.payTopupInternal(ctx);
    expect(JSON.stringify(sink)).toContain("v1:topup:currency:idr");
    const orders = await prisma.order.count({ where: { userId: sample.user.id } });
    expect(orders).toBe(0);
  });

  // Whole-branch review D9. The shop-wide rail floor (`min_order_amount_idr`)
  // is enforced inside `finalizeOrderPayment`, which an IDR top-up shares with
  // product checkout — so the buyer used to be told to "add more items" on a
  // screen with no cart, right after typing an amount they could simply have
  // typed larger. This pins the sentence at the surface the buyer actually reads.
  it("payTopupTokopay refused by the shop-wide rail minimum says to top up more, not to add items", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "min_order_amount_idr", "10000");
    const { ctx, sink } = customerCtx({
      session: { ...userSession(), scratch: { topupCurrency: "IDR", topupAmount: "5000" } },
    });
    await walletTopup.payTopupTokopay(ctx);

    const shown = JSON.stringify(sink);
    expect(shown).toContain("Please top up a larger amount");
    expect(shown).not.toMatch(/add more items/i);
    // And nothing was created: the guard runs before finalize writes anything.
    expect(await prisma.order.count({ where: { userId: sample.user.id } })).toBe(0);
  });

  it("payTopupTokopay refuses a wrong-currency scratch (USDT) instead of creating an IDR order", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    const { ctx } = customerCtx({
      session: { ...userSession(), scratch: { topupCurrency: "USDT", topupAmount: "5" } },
    });
    await walletTopup.payTopupTokopay(ctx);
    const orders = await prisma.order.count({ where: { userId: sample.user.id } });
    expect(orders).toBe(0);
  });
});

// ===========================================================================
// The advertised minimum (whole-branch review F4b)
//
// `wallet.topup_min_hint` used to read only the wallet-top-up bounds, so a shop
// with a Rp10.000 rail floor and a Rp1.000 top-up minimum told the buyer
// "Minimum Rp1.000" and then refused them at Rp5.000 — the prompt and the guard
// quoting different figures on consecutive screens. The hint now advertises the
// EFFECTIVE minimum: the larger of the top-up bound and the lowest floor among
// the rails this currency can actually be paid through.
// ===========================================================================

describe("the amount prompt advertises the effective minimum", () => {
  it("quotes the shop-wide rail floor when it is higher than the top-up bound", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "wallet_topup_min_amount_idr", "1000");
    await setSetting(prisma, "min_order_amount_idr", "10000");

    const { ctx, sink } = customerCtx();
    await walletTopup.promptTopupAmount(ctx, "IDR");

    const shown = JSON.stringify(sink);
    // English buyer: English separators (was "Rp10.000" before prices followed the buyer's language).
    expect(shown).toContain("Rp10,000");
    // The figure it used to quote, which the buyer would then have been refused at — in either spelling.
    expect(shown).not.toContain("Rp1,000");
    expect(shown).not.toContain("Rp1.000");
  });

  it("quotes a rail's OWN minimum when that is what binds", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "tokopay_min_amount", "20000");

    const { ctx, sink } = customerCtx();
    await walletTopup.promptTopupAmount(ctx, "IDR");
    expect(JSON.stringify(sink)).toContain("Rp20,000"); // English buyer (was "Rp20.000")
  });

  it("keeps the top-up bound when it is the higher of the two", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "min_order_amount_idr", "1000");
    await setSetting(prisma, "wallet_topup_min_amount_idr", "50000");

    const { ctx, sink } = customerCtx();
    await walletTopup.promptTopupAmount(ctx, "IDR");
    expect(JSON.stringify(sink)).toContain("Rp50,000"); // English buyer (was "Rp50.000")
  });

  it("refuses a typed amount the effective minimum rejects, re-prompting with that same figure", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "min_order_amount_idr", "10000");

    const { ctx, sink } = customerCtx();
    await walletTopup.handleTopupAmountInput(ctx, "IDR", "5000");

    const shown = JSON.stringify(sink);
    expect(shown).toContain("valid amount");
    expect(shown).toContain("Rp10,000"); // English buyer (was "Rp10.000")
    // Still capturing: the buyer retypes into the same screen rather than being
    // dropped into a gateway picker with nothing in it.
    expect(ctx.session.awaitingTopupCurrency).toBe("IDR");
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBeUndefined();
  });

  it("accepts an amount that clears the effective minimum and moves on to the gateway picker", async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "min_order_amount_idr", "10000");

    const { ctx, sink } = customerCtx();
    await walletTopup.handleTopupAmountInput(ctx, "IDR", "15000");

    expect(ctx.session.awaitingTopupCurrency).toBeUndefined();
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBe("15000");
    expect(JSON.stringify(sink)).toContain("v1:topup:pay:tokopay");
  });
});

// ===========================================================================
// One bubble for the whole top-up: currency → amount → invalid amount →
// valid amount → rail → QR, with the exact Telegram calls of every step
// (message budget, AGENTS.md).
// ===========================================================================

describe("wallet top-up stays in one bubble — exact Telegram call counts", () => {
  const BUBBLE = 600;
  const SCREEN = ["sendMessage", "reply", "editMessageText", "editMessageCaption", "deleteMessage", "replyWithPhoto", "sendPhoto"];
  const screen = (sink: SentCall[], from: number) => sink.slice(from).filter((c) => SCREEN.includes(c.method)).map((c) => c.method);

  async function enableTokopay() {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
    await setSetting(prisma, "min_order_amount_idr", "10000");
  }

  function flow() {
    const sink: SentCall[] = [];
    const session = { ...userSession(), menuMsgId: BUBBLE } as SessionData;
    const bubble = () => ({ message_id: session.menuMsgId!, chat: { id: 42, type: "private" }, date: 0 });
    const tap = (data: string, extra: Parameters<typeof makeCtx>[0] = {}) =>
      makeCtx({ sink, sharedSession: session, from: { id: 42 }, callbackData: data, cbMessage: bubble(), ...extra }).ctx;
    const typed = (text: string) => makeCtx({ sink, sharedSession: session, from: { id: 42 }, text }).ctx;
    return { sink, session, tap, typed };
  }

  /** Drive currency → invalid → valid, asserting each step; returns the flow. */
  async function upToRailPicker() {
    const f = flow();
    // Currency picked: the amount prompt edits the tapped wallet bubble.
    let mark = f.sink.length;
    await routeCallback(f.tap("v1:topup:currency:idr"));
    expect(screen(f.sink, mark)).toEqual(["editMessageText"]);
    expect(f.session.awaitingTopupCurrency).toBe("IDR");

    // Invalid amount: deleted, the same bubble re-renders with the error.
    mark = f.sink.length;
    const bad = f.typed("5000");
    await walletTopup.handleTopupAmountInput(bad, "IDR", "5000");
    expect(screen(f.sink, mark)).toEqual(["deleteMessage", "editMessageText"]);
    expect(f.sink.slice(mark).find((c) => c.method === "deleteMessage")!.args[1]).toBe(bad.message!.message_id);
    expect(f.sink.slice(mark).find((c) => c.method === "editMessageText")!.args[1]).toBe(BUBBLE);
    expect(JSON.stringify(f.sink.slice(mark))).toContain("valid amount");

    // Valid amount: deleted, and the rail picker EDITS the same bubble.
    mark = f.sink.length;
    const good = f.typed("15000");
    await walletTopup.handleTopupAmountInput(good, "IDR", "15000");
    expect(screen(f.sink, mark)).toEqual(["deleteMessage", "editMessageText"]);
    const railEdit = f.sink.slice(mark).find((c) => c.method === "editMessageText")!;
    expect(railEdit.args[1]).toBe(BUBBLE);
    expect(JSON.stringify(railEdit.args)).toContain("v1:topup:pay:tokopay");
    expect(f.session.menuMsgId).toBe(BUBBLE);
    return f;
  }

  it("currency → invalid amount → valid amount → rail → QR: edits until the QR photo, which is the only new message", async () => {
    await enableTokopay();
    const f = await upToRailPicker();

    // Rail tapped: the QR photo is sent and the picker bubble deleted right after it.
    const mark = f.sink.length;
    await walletTopup.payTopupTokopay(f.tap("v1:topup:pay:tokopay", { replyWithPhotoResult: { photo: [{ file_id: "qr" }] } }));
    expect(screen(f.sink, mark)).toEqual(["replyWithPhoto", "deleteMessage"]);
    expect(f.sink.slice(mark).find((c) => c.method === "deleteMessage")!.args[1]).toBe(BUBBLE);

    expect(calls(f.sink, "sendMessage")).toHaveLength(0);
    expect(calls(f.sink, "reply")).toHaveLength(0);
    const order = await prisma.order.findFirstOrThrow({ where: { userId: sample.user.id } });
    const anchor = await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } });
    expect(anchor?.messageId).toBe(f.session.menuMsgId);
    expect(anchor?.messageKind).toBe("photo");
  });

  it("the typed amount is deleted only after it has been captured", async () => {
    await enableTokopay();
    const f = flow();
    f.session.awaitingTopupCurrency = "IDR";
    const good = f.typed("15000");
    let amountAtDelete: unknown = "not deleted";
    const realDelete = good.api.deleteMessage.bind(good.api);
    (good.api as unknown as { deleteMessage: typeof realDelete }).deleteMessage = (async (...args: Parameters<typeof realDelete>) => {
      amountAtDelete = (f.session.scratch as Record<string, unknown>).topupAmount;
      return realDelete(...args);
    }) as typeof realDelete;
    await walletTopup.handleTopupAmountInput(good, "IDR", "15000");
    expect(amountAtDelete).toBe("15000");
  });

  it("when the QR photo cannot be sent, the text fallback EDITS the picker bubble — nothing is sent twice", async () => {
    await enableTokopay();
    const f = await upToRailPicker();

    const mark = f.sink.length;
    const railTap = f.tap("v1:topup:pay:tokopay");
    (railTap as unknown as { replyWithPhoto: () => Promise<never> }).replyWithPhoto = () => Promise.reject(new Error("wrong file identifier/HTTP URL specified"));
    await walletTopup.payTopupTokopay(railTap);

    expect(screen(f.sink, mark)).toEqual(["editMessageText"]);
    expect(calls(f.sink, "sendMessage")).toHaveLength(0);
    expect(calls(f.sink, "reply")).toHaveLength(0);
    expect(f.session.menuMsgId).toBe(BUBBLE);
    const order = await prisma.order.findFirstOrThrow({ where: { userId: sample.user.id } });
    const anchor = await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } });
    expect(anchor?.messageId).toBe(BUBBLE);
    expect(anchor?.messageKind).toBe("text");
  });
});

// ===========================================================================
// The typed amount is read by its shape (parseMoneyInput), not by stripping
// commas. Rupiah is shown in the buyer's language ("Rp10.000" to an Indonesian
// buyer), so a buyer copying what they see must get that amount — and a USDT
// decimal comma ("5,5") must never turn into ten times the money.
// ===========================================================================

describe("the typed top-up amount is parsed by its shape", () => {
  function indonesianCtx() {
    return customerCtx({ session: { ...userSession(), lang: "id" } });
  }

  async function enableTokopay() {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
  }

  async function enableBinanceInternal() {
    await setSetting(prisma, BINANCE_UID_KEY, "UID123");
    await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
    await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    await setSetting(prisma, "usd_idr_rate", "16000");
  }

  it("IDR: an Indonesian buyer typing the advertised minimum \"10.000\" tops up Rp10.000", async () => {
    await enableTokopay();
    await setSetting(prisma, "min_order_amount_idr", "10000");

    const { ctx, sink } = indonesianCtx();
    await walletTopup.handleTopupAmountInput(ctx, "IDR", "10.000");

    expect(ctx.session.awaitingTopupCurrency).toBeUndefined();
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBe("10000");
    expect(JSON.stringify(sink)).toContain("v1:topup:pay:tokopay");
  });

  it("IDR: \"1.000.000\" is one million rupiah, not an invalid entry", async () => {
    await enableTokopay();

    const { ctx } = indonesianCtx();
    await walletTopup.handleTopupAmountInput(ctx, "IDR", "1.000.000");

    expect(ctx.session.awaitingTopupCurrency).toBeUndefined();
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBe("1000000");
  });

  it("USDT: \"5,5\" is 5.5 USDT, never 55", async () => {
    await enableBinanceInternal();

    const { ctx } = indonesianCtx();
    await walletTopup.handleTopupAmountInput(ctx, "USDT", "5,5");

    expect(ctx.session.awaitingTopupCurrency).toBeUndefined();
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBe("5.5");
  });

  it("USDT: the ambiguous \"1.000\" is refused with the invalid-amount reply and capture stays on", async () => {
    await enableBinanceInternal();

    const { ctx, sink } = customerCtx();
    await walletTopup.handleTopupAmountInput(ctx, "USDT", "1.000");

    expect(JSON.stringify(sink)).toContain("valid amount");
    expect(ctx.session.awaitingTopupCurrency).toBe("USDT");
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBeUndefined();
  });

  // Money audit C11: the same amount judgement as createWalletTopupOrder, so
  // the prompt re-asks instead of carrying an amount the order step refuses.
  it.each([
    ["USDT", "5,12345"],
    ["IDR", "999999999999"],
    ["IDR", "0"],
  ] as const)("%s: %j is refused at the prompt and capture stays on", async (currency, typed) => {
    await enableTokopay();
    await enableBinanceInternal();

    const { ctx, sink } = customerCtx();
    await walletTopup.handleTopupAmountInput(ctx, currency, typed);

    expect(JSON.stringify(sink)).toContain("valid amount");
    expect(ctx.session.awaitingTopupCurrency).toBe(currency);
    expect((ctx.session.scratch as Record<string, unknown>).topupAmount).toBeUndefined();
  });
});
