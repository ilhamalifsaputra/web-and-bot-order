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
} from "@app/db";
import { NOWPAYMENTS_API_KEY_KEY, NOWPAYMENTS_IPN_SECRET_KEY } from "@app/core/payments/nowpayments";
import { PAYDISINI_USERKEY_KEY, PAYDISINI_APIKEY_KEY } from "@app/core/payments/paydisini";
import { OrderStatus, PaymentMethod, UserRole, VoucherType } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { makeCtx, calls, sentIncludes, type SentCall } from "./helpers/ctx";
import type { MyContext, SessionData } from "../src/context";
import { currentUsdtRate, invalidateRateCache } from "../src/util/rate";
import { ctxPriceFormatter, usdtFromIdr } from "../src/util/format";
import { t } from "../src/util/i18n";
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

type Pay = (ctx: MyContext, productId: number, quantity: number) => Promise<void>;

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
    pay: (c, p, q) => checkout.buyNowTokopay(c, p, q),
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
    pay: (c, p, q) => checkout.buyNowPaydisini(c, p, q),
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
    pay: (c, p, q) => checkout.buyNowInternal(c, p, q),
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
    pay: (c, p, q) => checkout.buyNowBybit(c, p, q),
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
    pay: (c, p, q) => checkout.buyNowBybitBsc(c, p, q),
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
    pay: (c, p, q) => checkout.buyNowNowpayments(c, p, q),
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
    pay: (c, p, q) => checkout.completeOrderWithWallet(c, p, q),
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
    pay: (c, p, q) => checkout.completeOrderWithWallet(c, p, q),
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

function tap(session: SessionData, callback: string, sink: SentCall[] = []) {
  return makeCtx({
    sink,
    sharedSession: session,
    from: { id: 42, username: "tester" },
    callbackData: `${callback}:${sample.product.id}:1`,
    cbMessage: { message_id: BUBBLE, chat: { id: 42, type: "private" }, date: 0 },
    replyWithPhotoResult: { photo: [{ file_id: "qr" }] },
  });
}

/** Render the screen the rail's pay button lives on, as the buyer saw it. */
async function render(rail: Rail, session: SessionData) {
  const { ctx } = tap(session, rail.screen === "usdt" ? "v1:pay:usdt" : "v1:buy");
  if (rail.screen === "usdt") await checkout.showUsdtMethods(ctx, sample.product.id, 1);
  else await checkout.showOrderConfirmation(ctx, sample.product.id, 1);
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
    await render(rail, session);
    // 80000 less SAVE10 = 72000; stored before any wallet credit, as a plain Decimal string.
    expect(session.scratch.quotedTotalIdr).toBe("72000");
    const balanceBefore = await getUser(prisma, sample.user.id);

    const { ctx } = tap(session, rail.callback);
    await rail.pay(ctx, sample.product.id, 1);

    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(orders[0]!.paymentMethod).toBe(rail.method);
    expect(netIdr(orders[0]!).equals(72000)).toBe(true);
    expect(orders[0]!.checkoutIntentId).toBe(INTENT);
    expect(await voucherUses()).toBe(1);
    // The quote is consumed with the checkout attempt.
    expect(session.scratch.quotedTotalIdr).toBeUndefined();
    expect(session.scratch.checkoutIntentId).toBeUndefined();
    const after = (await getUser(prisma, sample.user.id))!;
    if (rail.scratch.useWalletIdr) expect(new Decimal(balanceBefore!.walletBalance).minus(after.walletBalance).equals(72000)).toBe(true);
    if (rail.scratch.useWalletUsdt) {
      expect(new Decimal(balanceBefore!.walletBalanceUsdt).minus(after.walletBalanceUsdt).equals(usdtFromIdr(new Decimal(72000), new Decimal(16000)))).toBe(true);
    }
  });

  it("price changed between render and tap: no order, no debit, no voucher use; one edit with the new total; paying again succeeds", async () => {
    const session = await buyerSession(rail);
    await render(rail, session);
    expect(session.scratch.quotedTotalIdr).toBe("72000");
    await prisma.denomination.update({ where: { id: sample.product.id }, data: { price: "90000" } });
    const balanceBefore = (await getUser(prisma, sample.user.id))!;

    const sink: SentCall[] = [];
    const { ctx } = tap(session, rail.callback, sink);
    await rail.pay(ctx, sample.product.id, 1);

    expect(await ordersOf()).toHaveLength(0);
    expect(await voucherUses()).toBe(0);
    const after = (await getUser(prisma, sample.user.id))!;
    expect(new Decimal(after.walletBalance).equals(balanceBefore.walletBalance)).toBe(true);
    expect(new Decimal(after.walletBalanceUsdt).equals(balanceBefore.walletBalanceUsdt)).toBe(true);
    expectOneEditOnly(sink);
    // 90000 less SAVE10 = 81000, shown in the buyer's display currency.
    const changed = t(ctx, "checkout.price_changed", { total: ctxPriceFormatter(ctx, await currentUsdtRate()).price(new Decimal(81000)) });
    expect(sentIncludes(sink, changed)).toBe(true);
    expect(calls(sink, "editMessageText")[0]!.args.some((a) => typeof a === "string" && a.includes(changed))).toBe(true);
    expect(session.scratch.quotedTotalIdr).toBe("81000");
    expect(session.scratch.checkoutIntentId).toBe(INTENT);
    expect(session.scratch.customerData).toBe(JSON.stringify([{ note: "keep-me" }]));
    expect(session.scratch.appliedVoucherCode).toBe("SAVE10");

    // The buyer confirms the new price with a second tap.
    const again = tap(session, rail.callback).ctx;
    await rail.pay(again, sample.product.id, 1);
    const orders = await ordersOf();
    expect(orders).toHaveLength(1);
    expect(netIdr(orders[0]!).equals(81000)).toBe(true);
    expect(orders[0]!.checkoutIntentId).toBe(INTENT);
    expect(orders[0]!.customerData).toBe(JSON.stringify([{ note: "keep-me" }]));
  });

  it("missing quote (stale session): re-renders the payment screen in one edit instead of paying", async () => {
    const session = await buyerSession(rail);
    const sink: SentCall[] = [];
    const { ctx } = tap(session, rail.callback, sink);
    await rail.pay(ctx, sample.product.id, 1);

    expect(await ordersOf()).toHaveLength(0);
    expectOneEditOnly(sink);
    expect(sentIncludes(sink, "Confirm Order")).toBe(true);
    // The re-render stored the quote the buyer is now looking at.
    expect(session.scratch.quotedTotalIdr).toBe("72000");
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

    await checkout.buyNowTokopay(tap(session, "v1:payq").ctx, sample.product.id, 1);
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
    await render(RAILS[0]!, session);
    expect(session.scratch.quotedTotalIdr).toBe("0");

    await checkout.completeOrderWithWallet(tap(session, "v1:walletpay").ctx, sample.product.id, 1);
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

    await checkout.buyNowTokopay(tap(session, "v1:payq").ctx, sample.product.id, 1);
    expect(await ordersOf()).toHaveLength(1);
  });

  it("a bulk discount is quoted exactly as the order charges it", async () => {
    await upsertBulkPricing(prisma, { denominationId: sample.product.id, minQuantity: 3, discountPercent: "33" });
    const session = await buyerSession(RAILS[0]!);
    delete session.scratch.customerData;
    delete session.scratch.customerInputOwner;
    await checkout.showOrderConfirmation(tap(session, "v1:buy").ctx, sample.product.id, 3);
    const quote = session.scratch.quotedTotalIdr;

    await checkout.buyNowTokopay(tap(session, "v1:payq").ctx, sample.product.id, 3);
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

    await checkout.buyNowTokopay(tap(session, "v1:payq").ctx, sample.product.id, 1);
    expect(await ordersOf()).toHaveLength(1);
  });
});
