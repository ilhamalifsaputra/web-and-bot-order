// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

/**
 * Price lock (Game Top-up Phase 3, Task 2): every bot pay path sends the IDR
 * total its payment screen showed (`scratch.quotedTotalIdr`, the
 * `computeConfirmation().subtotalBeforeWallet` of the last render) as
 * `expectedTotal`, so a price that moved between the screen and the tap is
 * never charged. On a mismatch the order is not created and the same bubble is
 * re-rendered with the new total and a "price changed" line; the buyer taps pay
 * again to confirm it. A missing quote (stale session) re-renders instead of
 * paying.
 *
 * Every pay button carries the nonce of the render that stored the quote, and
 * only a tap with that nonce pays (T2b). A second tap queued from the screen
 * the buyer saw before a "price changed" re-render carries the old nonce, so it
 * re-renders instead of paying the new price its sender never saw.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/core/payments/tokopay", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/tokopay")>()),
  createTransaction: vi.fn().mockResolvedValue({ trxId: "TP-TEST", payUrl: null, qrLink: "https://x/qr.png", qrString: "000", totalBayar: "100" }),
}));
vi.mock("@app/core/payments/paydisini", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/paydisini")>()),
  createTransaction: vi.fn().mockResolvedValue({ trxId: "PD-TEST", qrString: "000", qrUrl: "https://x/pd-qr.png", checkoutUrl: null, totalBayar: "100" }),
}));
// Observed (and, in two tests, steered) on the bot's side of the package
// boundary: the bot's own imports of these are swapped, the db package's
// internal calls are not.
vi.mock("@app/db", async (orig) => {
  const actual = await orig<typeof import("@app/db")>();
  return {
    ...actual,
    createOrderDirect: vi.fn(actual.createOrderDirect),
    applyVoucherToSubtotal: vi.fn(actual.applyVoucherToSubtotal),
  };
});
vi.mock("@app/core/payments/nowpayments", async (orig) => ({
  ...(await orig<typeof import("@app/core/payments/nowpayments")>()),
  createInvoice: vi.fn().mockResolvedValue({ invoiceId: "NP-TEST", invoiceUrl: "https://nowpayments.test/invoice/NP-TEST" }),
}));

import {
  prisma,
  setSetting,
  adjustWallet,
  getUser,
  createVoucher,
  upsertBulkPricing,
  BINANCE_UID_KEY,
  BINANCE_API_KEY_KEY,
  BINANCE_API_SECRET_KEY,
  BYBIT_UID_KEY,
  BYBIT_API_KEY_KEY,
  BYBIT_API_SECRET_KEY,
  BYBIT_BSC_DEPOSIT_ADDRESS_KEY,
  BYBIT_BSC_ENABLED_KEY,
  createOrderDirect,
  applyVoucherToSubtotal,
} from "@app/db";
import { NOWPAYMENTS_API_KEY_KEY, NOWPAYMENTS_IPN_SECRET_KEY } from "@app/core/payments/nowpayments";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY } from "@app/core/payments/paydisini";
import { OrderStatus, PaymentMethod, UserRole, VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, lastMarkup, type SentCall } from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { currentUsdtRate, invalidateRateCache } from "../src/util/rate";
import { ctxPriceFormatter, usdtFromIdr } from "../src/util/format";
import { coreT, t } from "../src/util/i18n";
import * as checkout from "../src/handlers/checkout";

let sample: SampleData;

beforeEach(async () => {
  await resetDb(prisma);
  invalidateRateCache();
  sample = await buildSampleData(prisma);
  // A price the USDT rails can actually charge (5.00 IDR rounds to dust).
  await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "80000" } });
  await setSetting(prisma, "usd_idr_rate", "16000");
});

afterAll(async () => {
  await prisma.$disconnect();
});

const BUBBLE = 7001;
const INTENT = "99999999-9999-9999-9999-999999999999";

type Pay = (ctx: MyContext, productId: number, quantity: number, nonce?: string) => Promise<void>;

interface Rail {
  name: string;
  /** Where the pay button lives: the confirmation screen or the USDT submenu. */
  screen: "confirm" | "usdt";
  method: string;
  callback: string;
  scratch: Record<string, unknown>;
  setup: () => Promise<void>;
  pay: Pay;
}

const RAILS: Rail[] = [
  {
    name: "buyNowTokopay",
    screen: "confirm",
    method: PaymentMethod.TOKOPAY,
    callback: "v1:payq",
    scratch: {},
    setup: async () => {
      await setSetting(prisma, "tokopay_merchant_id", "M1");
      await setSetting(prisma, "tokopay_secret", "S1");
    },
    pay: (c, p, q, n) => checkout.buyNowTokopay(c, p, q, n),
  },
  {
    name: "buyNowPaydisini",
    screen: "confirm",
    method: PaymentMethod.PAYDISINI,
    callback: "v1:payd",
    scratch: {},
    setup: async () => {
      await setSetting(prisma, PAYDISINI_USERKEY_KEY, "uk");
      await setSetting(prisma, PAYDISINI_APIKEY_KEY, "ak");
    },
    pay: (c, p, q, n) => checkout.buyNowPaydisini(c, p, q, n),
  },
  {
    name: "buyNowInternal",
    screen: "usdt",
    method: PaymentMethod.BINANCE_INTERNAL,
    callback: "v1:payx",
    scratch: {},
    setup: async () => {
      await setSetting(prisma, BINANCE_UID_KEY, "UID123");
      await setSetting(prisma, BINANCE_API_KEY_KEY, "key");
      await setSetting(prisma, BINANCE_API_SECRET_KEY, "secret");
    },
    pay: (c, p, q, n) => checkout.buyNowInternal(c, p, q, n),
  },
  {
    name: "buyNowBybit",
    screen: "usdt",
    method: PaymentMethod.BYBIT,
    callback: "v1:payb",
    scratch: {},
    setup: async () => {
      await setSetting(prisma, BYBIT_UID_KEY, "BYUID1");
      await setSetting(prisma, BYBIT_API_KEY_KEY, "key");
      await setSetting(prisma, BYBIT_API_SECRET_KEY, "secret");
    },
    pay: (c, p, q, n) => checkout.buyNowBybit(c, p, q, n),
  },
  {
    name: "buyNowBybitBsc",
    screen: "usdt",
    method: PaymentMethod.BYBIT_BSC,
    callback: "v1:paybc",
    scratch: {},
    setup: async () => {
      await setSetting(prisma, BYBIT_BSC_DEPOSIT_ADDRESS_KEY, "0xDEADBEEF");
      await setSetting(prisma, BYBIT_API_KEY_KEY, "key");
      await setSetting(prisma, BYBIT_API_SECRET_KEY, "secret");
      await setSetting(prisma, BYBIT_BSC_ENABLED_KEY, "true");
    },
    pay: (c, p, q, n) => checkout.buyNowBybitBsc(c, p, q, n),
  },
  {
    name: "buyNowNowpayments",
    screen: "usdt",
    method: PaymentMethod.NOWPAYMENTS,
    callback: "v1:payn",
    scratch: {},
    setup: async () => {
      await setSetting(prisma, NOWPAYMENTS_API_KEY_KEY, "ak");
      await setSetting(prisma, NOWPAYMENTS_IPN_SECRET_KEY, "secret");
    },
    pay: (c, p, q, n) => checkout.buyNowNowpayments(c, p, q, n),
  },
  {
    name: "completeOrderWithWallet (IDR credit)",
    screen: "confirm",
    method: PaymentMethod.WALLET,
    callback: "v1:walletpay",
    scratch: { useWalletIdr: true },
    setup: async () => {
      await adjustWallet(prisma, sample.user.id, "500000", { currency: "IDR", reason: "admin_adjust" });
    },
    pay: (c, p, q, n) => checkout.completeOrderWithWallet(c, p, q, n),
  },
  {
    name: "completeOrderWithWallet (USDT credit)",
    screen: "confirm",
    method: PaymentMethod.WALLET,
    callback: "v1:walletpay",
    scratch: { useWalletUsdt: true },
    setup: async () => {
      await adjustWallet(prisma, sample.user.id, "100", { currency: "USDT", reason: "admin_adjust" });
    },
    pay: (c, p, q, n) => checkout.completeOrderWithWallet(c, p, q, n),
  },
];

/** The session a buyer carries into checkout: a voucher, typed account data and
 *  the checkout attempt id, so a mismatch can be shown to keep all three. */
async function buyerSession(rail: Rail): Promise<SessionData> {
  const d = await prisma.denomination.findUniqueOrThrow({ where: { id: sample.product.id } });
  return {
    lang: "en",
    menuMsgId: BUBBLE,
    scratch: {
      appliedVoucherCode: "SAVE10",
      customerData: JSON.stringify([{ note: "keep-me" }]),
      customerInputOwner: JSON.stringify([sample.product.id, 1, d.additionalFields, d.providerInputMapping, d.nicknameCheckGameCode]),
      checkoutIntentId: INTENT,
      ...rail.scratch,
    },
    dbUser: {
      id: sample.user.id,
      telegramId: String(sample.user.telegramId),
      role: sample.user.role,
      language: sample.user.language,
      referralCode: sample.user.referralCode,
      walletBalance: String(sample.user.walletBalance),
      preferredCurrency: null,
    },
  } as unknown as SessionData;
}

function tap(session: SessionData, callback: string, sink: SentCall[] = [], nonce?: string, quantity = 1) {
  return makeCtx({
    sink,
    sharedSession: session,
    from: { id: 42, username: "tester" },
    callbackData: `${callback}:${sample.product.id}:${quantity}${nonce === undefined ? "" : `:${nonce}`}`,
    cbMessage: { message_id: BUBBLE, chat: { id: 42, type: "private" }, date: 0 },
    replyWithPhotoResult: { photo: [{ file_id: "qr" }] },
  });
}

/** The nonce on the last rendered keyboard's button for `callback` (its fifth
 *  segment: `v1:<domain>:<pid>:<qty>:<nonce>`), as the buyer's tap sends it. */
function nonceOn(sink: SentCall[], callback: string): string | undefined {
  const rows = (lastMarkup(sink)?.inline_keyboard ?? []) as Array<Array<{ callback_data?: string }>>;
  const data = rows.flat().map((b) => b.callback_data ?? "").find((d) => d.startsWith(`${callback}:`));
  return data?.split(":")[4];
}

/** Render the screen the rail's pay button lives on, as the buyer saw it, and
 *  return the nonce its pay button carries. */
async function render(rail: Rail, session: SessionData): Promise<string> {
  const sink: SentCall[] = [];
  const { ctx } = tap(session, rail.screen === "usdt" ? "v1:pay:usdt" : "v1:buy", sink);
  if (rail.screen === "usdt") await checkout.showUsdtMethods(ctx, sample.product.id, 1);
  else await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
  const nonce = nonceOn(sink, rail.callback);
  expect(nonce).toMatch(/^[0-9a-z]{6}$/);
  expect(nonce).toBe(session.scratch.quoteNonce);
  return nonce!;
}

/** Tap the rail's pay button carrying `nonce`. */
async function payWith(rail: Rail, session: SessionData, nonce: string | undefined, sink: SentCall[] = []) {
  const { ctx } = tap(session, rail.callback, sink, nonce);
  await rail.pay(ctx, sample.product.id, 1, nonce);
  return ctx;
}

/** The nonce of the screen the session last rendered, as a tap on it carries. */
function shownNonce(session: SessionData): string | undefined {
  const n = session.scratch.quoteNonce;
  return typeof n === "string" ? n : undefined;
}

/** The toast texts the handler answered the tap with (the router's own bare
 *  answer is not part of a direct handler call). */
function toasts(sink: SentCall[]): string[] {
  return calls(sink, "answerCallbackQuery")
    .map((c) => (c.args[0] as { text?: string } | undefined)?.text)
    .filter((x): x is string => typeof x === "string" && x.length > 0);
}

const ordersOf = () => prisma.order.findMany({ where: { userId: sample.user.id } });
const voucherUses = async () => (await prisma.voucher.findUniqueOrThrow({ where: { id: sample.voucher.id } })).usedCount;
const netIdr = (o: { subtotalAmount: Decimal.Value; bulkDiscountAmount: Decimal.Value; discountAmount: Decimal.Value }) =>
  new Decimal(o.subtotalAmount).minus(o.bulkDiscountAmount).minus(o.discountAmount);

/** Exactly one edit of the tapped bubble and nothing else on screen. */
function expectOneEditOnly(sink: SentCall[]) {
  expect(calls(sink, "editMessageText")).toHaveLength(1);
  for (const m of ["sendMessage", "reply", "replyWithPhoto", "sendPhoto", "sendDocument", "deleteMessage", "editMessageCaption"]) {
    expect(calls(sink, m)).toHaveLength(0);
  }
}

describe.each(RAILS)("price lock: $name", (rail) => {
  beforeEach(async () => {
    await rail.setup();
  });

  it("quote equals the current total: the order is created and charged exactly the shown IDR total", async () => {
    const session = await buyerSession(rail);
    const nonce = await render(rail, session);
    // 80000 less SAVE10 = 72000; stored before any wallet credit, as a plain Decimal string.
    expect(session.scratch.quotedTotalIdr).toBe("72000");
    expect(session.scratch.quoteFor).toBe(`${sample.product.id}:1`);
    const balanceBefore = await getUser(prisma, sample.user.id);

    await payWith(rail, session, nonce);

    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.paymentMethod).toBe(rail.method);
    expect(netIdr(orders[0]!).equals(72000)).toBe(true);
    expect(orders[0]!.checkoutIntentId).toBe(INTENT);
    expect(await voucherUses()).toBe(1);
    // The quote, its nonce and its key are consumed with the checkout attempt.
    expect(session.scratch.quotedTotalIdr).toBeUndefined();
    expect(session.scratch.quoteNonce).toBeUndefined();
    expect(session.scratch.quoteFor).toBeUndefined();
    expect(session.scratch.checkoutIntentId).toBeUndefined();
    const after = (await getUser(prisma, sample.user.id))!;
    if (rail.scratch.useWalletIdr) expect(new Decimal(balanceBefore!.walletBalance).minus(after.walletBalance).equals(72000)).toBe(true);
    if (rail.scratch.useWalletUsdt) {
      expect(new Decimal(balanceBefore!.walletBalanceUsdt).minus(after.walletBalanceUsdt).equals(usdtFromIdr(new Decimal(72000), new Decimal(16000)))).toBe(true);
    }
  });

  it("price changed between render and tap: no order, no debit, no voucher use; one edit with the new total; paying again succeeds", async () => {
    const session = await buyerSession(rail);
    const seen = await render(rail, session);
    expect(session.scratch.quotedTotalIdr).toBe("72000");
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "90000" } });
    const balanceBefore = (await getUser(prisma, sample.user.id))!;

    const sink: SentCall[] = [];
    const ctx = await payWith(rail, session, seen, sink);

    expect(await ordersOf()).toHaveLength(0);
    expect(await voucherUses()).toBe(0);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(new Decimal(after.walletBalance).equals(balanceBefore.walletBalance)).toBe(true);
    expect(new Decimal(after.walletBalanceUsdt).equals(balanceBefore.walletBalanceUsdt)).toBe(true);
    expectOneEditOnly(sink);
    // A mismatch answers with no toast text: the edited bubble says what happened.
    expect(toasts(sink)).toEqual([]);
    // 90000 less SAVE10 = 81000, shown in the buyer's display currency.
    const changed = t(ctx, "checkout.price_changed", { total: ctxPriceFormatter(ctx, await currentUsdtRate()).price(new Decimal(81000)) });
    expect(sentIncludes(sink, changed)).toBe(true);
    expect(calls(sink, "editMessageText")[0]!.args.some((a) => typeof a === "string" && a.includes(changed))).toBe(true);
    expect(session.scratch.quotedTotalIdr).toBe("81000");
    expect(session.scratch.checkoutIntentId).toBe(INTENT);
    expect(session.scratch.customerData).toBe(JSON.stringify([{ note: "keep-me" }]));
    expect(session.scratch.appliedVoucherCode).toBe("SAVE10");
    // The re-render drew its pay buttons with a new nonce.
    const shown = nonceOn(sink, rail.callback);
    expect(shown).toBe(session.scratch.quoteNonce);
    expect(shown).not.toBe(seen);

    // The buyer confirms the new price with a tap on the new screen.
    await payWith(rail, session, shown);
    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(netIdr(orders[0]!).equals(81000)).toBe(true);
    expect(orders[0]!.checkoutIntentId).toBe(INTENT);
    expect(orders[0]!.customerData).toBe(JSON.stringify([{ note: "keep-me" }]));
  });

  it("double-tap queued from the old screen: the second tap carries the old nonce and re-renders instead of paying the new price; only a tap from the new screen pays", async () => {
    const session = await buyerSession(rail);
    const seen = await render(rail, session);
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "90000" } });
    const balanceBefore = (await getUser(prisma, sample.user.id))!;

    // Tap 1: refused as a price change; the bubble now quotes 81000.
    await payWith(rail, session, seen);
    expect(await ordersOf()).toHaveLength(0);
    expect(session.scratch.quotedTotalIdr).toBe("81000");

    // Tap 2 was sent from the screen showing 72000, before the buyer saw the
    // new price. Updates for one chat run one at a time, so it is processed
    // after tap 1, finds the new quote stored, and must still not pay.
    const second: SentCall[] = [];
    const ctx = await payWith(rail, session, seen, second);
    expect(await ordersOf()).toHaveLength(0);
    expect(await voucherUses()).toBe(0);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(new Decimal(after.walletBalance).equals(balanceBefore.walletBalance)).toBe(true);
    expect(new Decimal(after.walletBalanceUsdt).equals(balanceBefore.walletBalanceUsdt)).toBe(true);
    expectOneEditOnly(second);
    expect(toasts(second)).toEqual([t(ctx, "error.stale_screen")]);
    expect(sentIncludes(second, "Confirm Order")).toBe(true);
    const latest = nonceOn(second, rail.callback);
    expect(latest).toBe(session.scratch.quoteNonce);
    expect(latest).not.toBe(seen);
    expect(session.scratch.checkoutIntentId).toBe(INTENT);

    // A tap from the screen now shown pays the price on it.
    await payWith(rail, session, latest);
    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(netIdr(orders[0]!).equals(81000)).toBe(true);
  });

  it("missing quote (stale session): re-renders the payment screen in one edit instead of paying", async () => {
    const session = await buyerSession(rail);
    const sink: SentCall[] = [];
    const ctx = await payWith(rail, session, "abc123", sink);

    expect(await ordersOf()).toHaveLength(0);
    expectOneEditOnly(sink);
    expect(toasts(sink)).toEqual([t(ctx, "error.stale_screen")]);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
    // The re-render stored the quote the buyer is now looking at.
    expect(session.scratch.quotedTotalIdr).toBe("72000");
    expect(nonceOn(sink, rail.callback)).toBe(session.scratch.quoteNonce);
  });

  it("a button without a nonce (a bubble from before the nonce) never pays, even with a valid quote stored", async () => {
    const session = await buyerSession(rail);
    await render(rail, session);
    const balanceBefore = (await getUser(prisma, sample.user.id))!;

    const sink: SentCall[] = [];
    const ctx = await payWith(rail, session, undefined, sink);

    expect(await ordersOf()).toHaveLength(0);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(new Decimal(after.walletBalance).equals(balanceBefore.walletBalance)).toBe(true);
    expect(new Decimal(after.walletBalanceUsdt).equals(balanceBefore.walletBalanceUsdt)).toBe(true);
    expectOneEditOnly(sink);
    expect(toasts(sink)).toEqual([t(ctx, "error.stale_screen")]);
  });
});

describe("price lock: what the quote is bound to", () => {
  beforeEach(async () => {
    await setSetting(prisma, "tokopay_merchant_id", "M1");
    await setSetting(prisma, "tokopay_secret", "S1");
  });

  it("applying and then removing a voucher refreshes the quote, so neither tap is a false mismatch", async () => {
    const session = await buyerSession(RAILS[0]!);
    delete session.scratch.appliedVoucherCode;
    await render(RAILS[0]!, session);
    expect(session.scratch.quotedTotalIdr).toBe("80000");

    // The voucher conversation ends on renderOrderConfirmation.
    session.scratch.appliedVoucherCode = "SAVE10";
    await checkout.renderOrderConfirmation(tap(session, "v1:buy").ctx, sample.product.id, 1);
    expect(session.scratch.quotedTotalIdr).toBe("72000");

    delete session.scratch.appliedVoucherCode;
    await checkout.renderOrderConfirmation(tap(session, "v1:buy").ctx, sample.product.id, 1);
    expect(session.scratch.quotedTotalIdr).toBe("80000");

    await checkout.buyNowTokopay(tap(session, "v1:payq", [], shownNonce(session)).ctx, sample.product.id, 1, shownNonce(session));
    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(netIdr(orders[0]!).equals(80000)).toBe(true);
  });

  it("the wallet-credit screens quote the total before credit, not the zero left to pay", async () => {
    await adjustWallet(prisma, sample.user.id, "500000", { currency: "IDR", reason: "admin_adjust" });
    const session = await buyerSession(RAILS[0]!);
    await checkout.showWalletCreditMenu(tap(session, "v1:walletm:open").ctx, sample.product.id, 1);
    expect(session.scratch.quotedTotalIdr).toBe("72000");
    await checkout.toggleWalletCredit(tap(session, "v1:walletm:idr").ctx, sample.product.id, 1, "IDR");
    expect(session.scratch.useWalletIdr).toBe(true);
    expect(session.scratch.quotedTotalIdr).toBe("72000");
  });

  it("a discount that covers the whole price quotes IDR 0 and settles through the Complete Order path", async () => {
    await createVoucher(prisma, { code: "FREE", type: VoucherType.PERCENT, value: "100", usageLimit: 10, minPurchase: "0" });
    const session = await buyerSession(RAILS[0]!);
    session.scratch.appliedVoucherCode = "FREE";
    // The screen collapses to the one Complete Order button.
    await render({ ...RAILS[0]!, callback: "v1:walletpay" }, session);
    expect(session.scratch.quotedTotalIdr).toBe("0");

    await checkout.completeOrderWithWallet(tap(session, "v1:walletpay", [], shownNonce(session)).ctx, sample.product.id, 1, shownNonce(session));
    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    expect(netIdr(orders[0]!).equals(0)).toBe(true);
  });

  it("a quote stored with trailing 4-dp zeros compares by value, and the stored quote survives a JSON round trip as a string", async () => {
    const session = await buyerSession(RAILS[0]!);
    await render(RAILS[0]!, session);
    const stored = session.scratch.quotedTotalIdr;
    expect(typeof stored).toBe("string");
    expect(JSON.parse(JSON.stringify(session.scratch)).quotedTotalIdr).toBe(stored);
    session.scratch.quotedTotalIdr = "72000.0000";

    await checkout.buyNowTokopay(tap(session, "v1:payq", [], shownNonce(session)).ctx, sample.product.id, 1, shownNonce(session));
    expect(await ordersOf()).toHaveLength(1);
  });

  it("a bulk discount is quoted exactly as the order charges it", async () => {
    await upsertBulkPricing(prisma, { denominationId: sample.product.id, minQuantity: 3, discountPercent: "33" });
    const session = await buyerSession(RAILS[0]!);
    delete session.scratch.customerData;
    delete session.scratch.customerInputOwner;
    await checkout.showOrderConfirmation(tap(session, "v1:buy").ctx, sample.product.id, 3);
    const quote = session.scratch.quotedTotalIdr;

    await checkout.buyNowTokopay(tap(session, "v1:payq", [], shownNonce(session), 3).ctx, sample.product.id, 3, shownNonce(session));
    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(new Decimal(orders[0]!.bulkDiscountAmount).greaterThan(0)).toBe(true);
    expect(netIdr(orders[0]!).equals(new Decimal(quote as string))).toBe(true);
  });

  // Divergence found while binding the quote: computeConfirmation priced with
  // the session's cached role (the warm user snapshot, up to 5 minutes old)
  // while createOrderDirect prices with the role it reads from the database. A
  // buyer promoted to reseller from web-admin inside that window was quoted the
  // customer price and refused on every tap, because each re-render quoted the
  // same stale figure.
  it("a role changed since the session was cached is quoted at the price the order will charge", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { role: UserRole.RESELLER } });
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { resellerPrice: "70000" } });
    const session = await buyerSession(RAILS[0]!);
    delete session.scratch.appliedVoucherCode;
    expect(session.dbUser!.role).not.toBe(UserRole.RESELLER);
    await render(RAILS[0]!, session);
    expect(session.scratch.quotedTotalIdr).toBe("70000");

    await checkout.buyNowTokopay(tap(session, "v1:payq", [], shownNonce(session)).ctx, sample.product.id, 1, shownNonce(session));
    expect(await ordersOf()).toHaveLength(1);
  });

  it("a tap for another quantity than the quote prices is a missing quote (stale-screen toast), not a changed price", async () => {
    const session = await buyerSession(RAILS[0]!);
    const nonce = await render(RAILS[0]!, session);
    expect(session.scratch.quoteFor).toBe(`${sample.product.id}:1`);

    const sink: SentCall[] = [];
    const { ctx } = tap(session, "v1:payq", sink, nonce, 2);
    await checkout.buyNowTokopay(ctx, sample.product.id, 2, nonce);

    expect(await ordersOf()).toHaveLength(0);
    expectOneEditOnly(sink);
    expect(toasts(sink)).toEqual([t(ctx, "error.stale_screen")]);
    expect(sentIncludes(sink, "⚠️")).toBe(false);
    // The re-render quotes the quantity the buyer is now looking at.
    expect(session.scratch.quoteFor).toBe(`${sample.product.id}:2`);
    expect(session.scratch.quoteNonce).not.toBe(nonce);
  });

  it("a malformed nonce is stale and never pays", async () => {
    const session = await buyerSession(RAILS[0]!);
    const nonce = await render(RAILS[0]!, session);
    for (const bad of [nonce.toUpperCase() === nonce ? "ZZZZZZ" : nonce.toUpperCase(), `${nonce}0`, "", "      "]) {
      const sink: SentCall[] = [];
      const { ctx } = tap(session, "v1:payq", sink, bad);
      await checkout.buyNowTokopay(ctx, sample.product.id, 1, bad);
      expect(await ordersOf()).toHaveLength(0);
      expect(toasts(sink)).toEqual([t(ctx, "error.stale_screen")]);
    }
  });

  it("a price change whose re-render returns early (out of stock) leaves no quote for a screen the buyer never saw", async () => {
    const session = await buyerSession(RAILS[0]!);
    const nonce = await render(RAILS[0]!, session);
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "90000" } });
    // The total is checked before stock, so this tap is refused as a changed
    // price, and the re-render then finds nothing left to sell.
    await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: "SOLD" } });

    const sink: SentCall[] = [];
    const { ctx } = tap(session, "v1:payq", sink, nonce);
    await checkout.buyNowTokopay(ctx, sample.product.id, 1, nonce);

    expect(await ordersOf()).toHaveLength(0);
    expect(sentIncludes(sink, t(ctx, "error.out_of_stock", { product: sample.product.name }))).toBe(true);
    expect(session.scratch.quotedTotalIdr).toBeUndefined();
    expect(session.scratch.quoteNonce).toBeUndefined();
    expect(session.scratch.quoteFor).toBeUndefined();
    // So even the nonce the buyer last saw cannot pay now.
    await checkout.buyNowTokopay(tap(session, "v1:payq", [], nonce).ctx, sample.product.id, 1, nonce);
    expect(await ordersOf()).toHaveLength(0);
  });

  it("discount-covered Complete Order: a discount that stops covering the price mid-tap is refused as a changed price, with the IDR 0 quote forwarded", async () => {
    await createVoucher(prisma, { code: "FREE", type: VoucherType.PERCENT, value: "100", usageLimit: 10, minPurchase: "0" });
    const session = await buyerSession(RAILS[0]!);
    session.scratch.appliedVoucherCode = "FREE";
    const nonce = await render({ ...RAILS[0]!, callback: "v1:walletpay" }, session);
    expect(session.scratch.quotedTotalIdr).toBe("0");

    // The voucher drops to 50% after the tap's own re-price and before the
    // order is written: the window only the quote binding closes.
    const actual = await vi.importActual<typeof import("@app/db")>("@app/db");
    vi.mocked(createOrderDirect).mockClear();
    vi.mocked(createOrderDirect).mockImplementationOnce(async (tx, args) => {
      await prisma.voucher.update({ where: { code: "FREE" }, data: { value: "50" } });
      return actual.createOrderDirect(tx, args);
    });

    const sink: SentCall[] = [];
    const { ctx } = tap(session, "v1:walletpay", sink, nonce);
    await checkout.completeOrderWithWallet(ctx, sample.product.id, 1, nonce);

    expect(vi.mocked(createOrderDirect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createOrderDirect).mock.calls[0]![1].expectedTotal).toEqual({ currency: "IDR", amount: "0" });
    expect(await ordersOf()).toHaveLength(0);
    expectOneEditOnly(sink);
    expect(toasts(sink)).toEqual([]);
    const changed = t(ctx, "checkout.price_changed", { total: ctxPriceFormatter(ctx, await currentUsdtRate()).price(new Decimal(40000)) });
    expect(sentIncludes(sink, changed)).toBe(true);
    expect(session.scratch.quotedTotalIdr).toBe("40000");
  });

  it("a discount larger than the subtotal is quoted as zero, as the order clamps it, never as a negative total", async () => {
    const session = await buyerSession(RAILS[0]!);
    // Forces the voucher cap to slip on this one render.
    vi.mocked(applyVoucherToSubtotal).mockImplementationOnce(() => new Decimal(999999));
    const sink: SentCall[] = [];
    await checkout.showOrderConfirmation(tap(session, "v1:buy", sink).ctx, sample.product.id, 1);

    expect(session.scratch.quotedTotalIdr).toBe("0");
    expect(nonceOn(sink, "v1:walletpay")).toBe(session.scratch.quoteNonce);

    // The tap re-prices with the real cap and lands on the true total once,
    // rather than looping on a quote no order can match.
    await checkout.completeOrderWithWallet(tap(session, "v1:walletpay", [], shownNonce(session)).ctx, sample.product.id, 1, shownNonce(session));
    expect(await ordersOf()).toHaveLength(0);
    expect(session.scratch.quotedTotalIdr).toBe("72000");
  });

  it("the price-changed line reads the same total placeholder in both languages", () => {
    expect(coreT("checkout.price_changed", "en", { total: "Rp81.000" })).toBe("⚠️ The price has changed to Rp81.000. Please check it, then confirm again.");
    expect(coreT("checkout.price_changed", "id", { total: "Rp81.000" })).toBe("⚠️ Harga berubah menjadi Rp81.000. Silakan cek lagi, lalu konfirmasi ulang.");
  });
});
