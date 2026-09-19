/**
 * Wallet top-up flow — buy wallet CREDIT itself through the existing payment
 * gateways, instead of paying for a product. Mirrors checkout.ts's buyNow*
 * rails structurally (gateway-claim dance, QR-bubble rendering,
 * anchorPaymentMessage anchoring) but creates a bare
 * WALLET_TOPUP order (packages/db/src/crud/wallet_topup.ts) instead of a
 * product order — no product/quantity, no voucher, no wallet-credit toggle.
 *
 * Flow: viewWallet's "Top Up" button -> showWalletTopupMenu (currency choice)
 * -> promptTopupAmount (captures the next text message as the amount, same
 * ctx.session.awaitingQtyDenomId-style capture as quantity entry) ->
 * topupMethodsKb (gateway picker) -> payTopup<Rail> (creates the order and
 * shows that rail's instructions, exactly like buyNow<Rail>).
 */
import { InlineKeyboard } from "grammy";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { localize } from "@app/core/datetime";
import { PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  getUser,
  countUserPendingOrders,
  createWalletTopupOrder,
  resolveWalletTopupLimits,
  walletTopupClearsRailMinimum,
  hasPendingWalletTopupOrder,
  resolveBinanceInternalConfig,
  resolveBybitConfig,
  resolveBybitBscConfig,
  getTokopayCreds,
  getPaydisiniCreds,
  getNowpaymentsCreds,
  cancelOrder,
  claimGatewaySlot,
  commitGatewayResult,
  releaseGatewaySlot,
  type WalletTopupLimits,
  type WalletTopupMethod,
} from "@app/db";
import { createTransaction, computeQrisAdminFee } from "@app/core/payments/tokopay";
import { createTransaction as createPaydisiniTransaction } from "@app/core/payments/paydisini";
import { createInvoice as createNowpaymentsInvoice } from "@app/core/payments/nowpayments";
import { triggerImmediatePoll as internalImmediatePoll } from "../payments/binanceInternal";
import { triggerImmediatePoll as bybitImmediatePoll } from "../payments/bybitDeposit";
import { triggerImmediatePoll as bybitBscImmediatePoll } from "../payments/bybitBscDeposit";
import type { MyContext } from "../context";
import { smartEdit, menuAnchor, consumeInput } from "../util/chat";
import { anchorPaymentMessage } from "../util/paymentAnchor";
import { t } from "../util/i18n";
import { esc, formatIdr, formatUsdtAmount } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";

const MAX_PENDING_ORDERS = 10;
const price = (v: Decimal.Value) => formatUsdtAmount(v);

// Double-tap / grammY-retry window, same rationale + value as checkout.ts's
// refuseDuplicateCheckout: a second tap on the same top-up+rail combo within
// this window must not create a second ghost order.
const DUPLICATE_TOPUP_WINDOW_MS = 30_000;

interface TopupScratch {
  topupCurrency?: "IDR" | "USDT";
  /** Decimal serialized as a string (session storage is a plain in-memory
   *  object; keeping scratch values as primitives avoids relying on Decimal
   *  instances surviving whatever the session store does with them). */
  topupAmount?: string;
}
const sc = (ctx: MyContext) => ctx.session.scratch as TopupScratch & Record<string, unknown>;

function requireUser(ctx: MyContext) {
  const u = ctx.session.dbUser;
  if (!u) throw new Error("walletTopup handler reached without a registered user");
  return u;
}

/** Format a bound per the currency it belongs to. */
function fmtBound(v: Decimal, currency: "IDR" | "USDT"): string {
  return currency === "IDR" ? formatIdr(v) : formatUsdtAmount(v);
}

/**
 * Optional "allowed range" line appended to the amount prompt / invalid-entry
 * message — mirrors checkout.ts's minAmountNote (blank when neither bound is
 * configured). Client-side UX only; createWalletTopupOrder re-validates for
 * real (packages/db/src/crud/wallet_topup.ts's own doc-comment).
 */
function topupRangeLine(ctx: MyContext, limits: WalletTopupLimits, currency: "IDR" | "USDT"): string {
  const min = currency === "IDR" ? limits.minIdr : limits.minUsdt;
  const max = currency === "IDR" ? limits.maxIdr : limits.maxUsdt;
  if (min && max) return "\n\n" + t(ctx, "wallet.topup_range_hint", { min: fmtBound(min, currency), max: fmtBound(max, currency) });
  if (min) return "\n\n" + t(ctx, "wallet.topup_min_hint", { min: fmtBound(min, currency) });
  if (max) return "\n\n" + t(ctx, "wallet.topup_max_hint", { max: fmtBound(max, currency) });
  return "";
}

/**
 * Refuses to proceed if the user already has a PENDING_PAYMENT top-up order
 * for the same rail created within the last DUPLICATE_TOPUP_WINDOW_MS — the
 * common double-tap/network-retry case. Answers/edits the screen itself and
 * returns true when a duplicate is found; the caller must stop.
 */
async function refuseDuplicateTopup(ctx: MyContext, userId: number, method: WalletTopupMethod): Promise<boolean> {
  const dupe = await hasPendingWalletTopupOrder(prisma, { userId, method, sinceMs: DUPLICATE_TOPUP_WINDOW_MS });
  if (!dupe) return false;
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: t(ctx, "checkout.duplicate_pending"), show_alert: true });
  } else {
    await smartEdit(ctx, t(ctx, "checkout.duplicate_pending"), ckb.backToMain(ctx.session.lang));
  }
  return true;
}

// ---------------------------------------------------------------------------
// Currency choice + amount capture
// ---------------------------------------------------------------------------

/** Wallet screen's "Top Up" button lands here: currency choice (IDR/USDT). */
export async function showWalletTopupMenu(ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  await smartEdit(ctx, t(ctx, "wallet.topup_choose_currency"), ckb.topupCurrencyKb(lang));
}

/** Currency picked -> prompt for the amount (captured as free text). */
export async function promptTopupAmount(ctx: MyContext, currency: "IDR" | "USDT"): Promise<void> {
  const lang = ctx.session.lang;
  const limits = await resolveWalletTopupLimits(prisma);
  const text = t(ctx, "wallet.topup_amount_prompt", { currency, range_line: topupRangeLine(ctx, limits, currency) });
  await smartEdit(ctx, text, ckb.topupAmountCancelKb(lang));
  // smartEdit just cleared this — set it AFTER rendering, same ordering
  // customer.qtyInputStart uses for awaitingQtyDenomId.
  ctx.session.awaitingTopupCurrency = currency;
}

/**
 * Free-text capture of the typed amount (main.ts's central message:text
 * router diverts here whenever ctx.session.awaitingTopupCurrency is set and
 * the text isn't a persistent-menu label) — same shape as customer.ts's
 * handleQtyTextInput for quantity entry. Validates client-side against
 * resolveWalletTopupLimits for immediate feedback only; createWalletTopupOrder
 * re-validates for real once a gateway is picked.
 */
export async function handleTopupAmountInput(ctx: MyContext, currency: "IDR" | "USDT", rawText: string): Promise<void> {
  await consumeInput(ctx);
  const lang = ctx.session.lang;
  const limits = await resolveWalletTopupLimits(prisma);
  const rangeLine = topupRangeLine(ctx, limits, currency);

  // Length cap before parsing — same defensive spirit as handleQtyTextInput's
  // digit-string checks, just guarding against a pathologically long paste
  // rather than a real amount.
  const trimmed = rawText.trim().replace(/,/g, "");
  const amount = trimmed.length <= 20 && /^\d+(\.\d+)?$/.test(trimmed) ? new Decimal(trimmed) : null;
  const min = currency === "IDR" ? limits.minIdr : limits.minUsdt;
  const max = currency === "IDR" ? limits.maxIdr : limits.maxUsdt;
  const valid =
    amount !== null &&
    amount.greaterThan(0) &&
    (!min || amount.greaterThanOrEqualTo(min)) &&
    (!max || amount.lessThanOrEqualTo(max));

  if (!valid) {
    await menuAnchor(ctx, t(ctx, "wallet.topup_amount_invalid", { range_line: rangeLine }), ckb.topupAmountCancelKb(lang));
    ctx.session.awaitingTopupCurrency = currency;
    return;
  }

  ctx.session.awaitingTopupCurrency = undefined;
  sc(ctx).topupCurrency = currency;
  sc(ctx).topupAmount = amount!.toString();
  await showTopupMethods(ctx, currency, amount!);
}

/**
 * Which rails a top-up in `currency` can be offered on.
 *
 * Two questions, deliberately kept in one place so the amount prompt and the
 * gateway picker can never disagree about them:
 *
 *  - CONFIGURED — does the shop have working credentials for that rail, and (for
 *    the four USDT rails) a usable exchange rate? Unchanged behaviour.
 *  - ACCEPTS THE AMOUNT — would `finalizeWalletTopupPayment`'s rail-minimum
 *    guard refuse it (whole-branch review F3)? Asked only when an amount is
 *    known, via the SAME `walletTopupClearsRailMinimum` the guard throws from, so
 *    a button a buyer can tap is always a rail their top-up can be finalized on.
 *    Pass `amount: null` to skip this half, which is what the amount prompt does
 *    — there is no amount to judge yet, and the prompt only needs to know which
 *    rails exist in order to advertise the right minimum.
 */
async function offeredTopupRails(
  currency: "IDR" | "USDT",
  amount: Decimal | null,
): Promise<{ rate: Decimal | null; methods: WalletTopupMethod[] }> {
  const rate = currency === "USDT" ? await currentUsdtRate() : null;
  const configured: WalletTopupMethod[] = [];
  if (currency === "IDR") {
    if ((await getTokopayCreds(prisma)) != null) configured.push(PaymentMethod.TOKOPAY);
    if ((await getPaydisiniCreds(prisma)) != null) configured.push(PaymentMethod.PAYDISINI);
  } else if (rate !== null) {
    if ((await resolveBinanceInternalConfig(prisma)).enabled) configured.push(PaymentMethod.BINANCE_INTERNAL);
    if ((await resolveBybitConfig(prisma)).enabled) configured.push(PaymentMethod.BYBIT);
    if ((await resolveBybitBscConfig(prisma)).enabled) configured.push(PaymentMethod.BYBIT_BSC);
    if ((await getNowpaymentsCreds(prisma)) != null) configured.push(PaymentMethod.NOWPAYMENTS);
  }
  if (amount === null) return { rate, methods: configured };

  const methods: WalletTopupMethod[] = [];
  for (const method of configured) {
    const query =
      currency === "IDR"
        ? ({ currency: "IDR", amount } as const)
        : ({ currency: "USDT", amount, rate: rate! } as const);
    if (await walletTopupClearsRailMinimum(prisma, { ...query, method })) methods.push(method);
  }
  return { rate, methods };
}

/** Amount captured -> show the gateway picker for the chosen currency. */
async function showTopupMethods(ctx: MyContext, currency: "IDR" | "USDT", amount: Decimal): Promise<void> {
  const lang = ctx.session.lang;
  const { methods } = await offeredTopupRails(currency, amount);

  // Every configured rail refused this amount. `handleTopupAmountInput` already
  // checks the effective minimum, so reaching here means either no rail is
  // configured for this currency at all, or an admin raised a floor between the
  // prompt and this tap. Say so instead of rendering a picker with nothing in
  // it — a keyboard whose only button is "Back" reads as a bug.
  if (methods.length === 0) {
    await smartEdit(ctx, t(ctx, "wallet.topup_no_rail_for_amount"), ckb.topupCurrencyKb(lang));
    return;
  }

  const offers = (method: WalletTopupMethod) => methods.includes(method);
  const amountText = currency === "IDR" ? formatIdr(amount) : formatUsdtAmount(amount);
  await smartEdit(
    ctx,
    t(ctx, "wallet.topup_choose_method", { currency, amount: amountText }),
    ckb.topupMethodsKb(
      currency,
      lang,
      offers(PaymentMethod.TOKOPAY),
      offers(PaymentMethod.PAYDISINI),
      offers(PaymentMethod.BINANCE_INTERNAL),
      offers(PaymentMethod.BYBIT),
      offers(PaymentMethod.BYBIT_BSC),
      offers(PaymentMethod.NOWPAYMENTS),
    ),
  );
}

/** Re-reads {currency, amount} off scratch. Null when the flow was entered
 *  out of order (a stale button tap) — callers show a stale-screen toast and
 *  return to the currency choice rather than crashing. */
function readTopupScratch(ctx: MyContext): { currency: "IDR" | "USDT"; amount: Decimal } | null {
  const currency = sc(ctx).topupCurrency;
  const raw = sc(ctx).topupAmount;
  if (!currency || !raw) return null;
  const amount = new Decimal(raw);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) return null;
  return { currency, amount };
}

async function staleTopupScreen(ctx: MyContext): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.stale_screen") });
  await showWalletTopupMenu(ctx);
}

// ---------------------------------------------------------------------------
// Gateway rails — each a close structural copy of its buyNow* counterpart in
// checkout.ts: same gateway-claim/QR-render/payment-message-anchoring code,
// createWalletTopupOrder instead of createOrderDirect/createInternalOrder/etc.
// ---------------------------------------------------------------------------

/** Binance Internal Transfer top-up. Mirrors checkout.buyNowInternal. */
export async function payTopupInternal(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const scratch = readTopupScratch(ctx);
  if (!scratch || scratch.currency !== "USDT") return void (await staleTopupScreen(ctx));

  const rate = await currentUsdtRate();
  const cfg = await resolveBinanceInternalConfig(prisma);
  if (!cfg.enabled || !rate) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateTopup(ctx, user.id, PaymentMethod.BINANCE_INTERNAL)) return;

  let order: Awaited<ReturnType<typeof createWalletTopupOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: user.id,
        amount: scratch.amount,
        currency: "USDT",
        method: PaymentMethod.BINANCE_INTERNAL,
        rate,
      }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order.paymentRef) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  delete sc(ctx).topupCurrency;
  delete sc(ctx).topupAmount;

  const fxRate = order.fxRate != null ? new Decimal(order.fxRate) : rate;
  const idrLine = ` (≈ ${formatIdr(new Decimal(order.totalAmount).times(fxRate))})`;
  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.INTERNAL_PAYMENT_WINDOW_MINUTES}m`;

  const text = t(ctx, "checkout.internal_instructions", {
    code: order.paymentRef,
    uid: esc(cfg.receiveUid),
    note: order.paymentRef,
    amount: price(order.totalAmount),
    idr_line: idrLine,
    expiry,
  });
  await smartEdit(
    ctx,
    text,
    ckb.proofCancelKb(order.id, lang, true, { uid: cfg.receiveUid, note: order.paymentRef }),
  );
  await anchorPaymentMessage(ctx, order.id, ctx.chat!.id);
  internalImmediatePoll(ctx.api);
}

/** Bybit Internal Transfer top-up. Mirrors checkout.buyNowBybit. */
export async function payTopupBybit(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const scratch = readTopupScratch(ctx);
  if (!scratch || scratch.currency !== "USDT") return void (await staleTopupScreen(ctx));

  const rate = await currentUsdtRate();
  const bybit = await resolveBybitConfig(prisma);
  if (!bybit.enabled || !rate) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateTopup(ctx, user.id, PaymentMethod.BYBIT)) return;

  let order: Awaited<ReturnType<typeof createWalletTopupOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: user.id,
        amount: scratch.amount,
        currency: "USDT",
        method: PaymentMethod.BYBIT,
        rate,
      }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  delete sc(ctx).topupCurrency;
  delete sc(ctx).topupAmount;

  const fxRate = order.fxRate != null ? new Decimal(order.fxRate) : rate;
  const idrLine = ` (≈ ${formatIdr(new Decimal(order.totalAmount).times(fxRate))})`;
  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.BYBIT_PAYMENT_WINDOW_MINUTES}m`;

  const text = t(ctx, "checkout.bybit_instructions", {
    code: order.orderCode,
    uid: esc(bybit.uid),
    amount: price(order.totalAmount),
    idr_line: idrLine,
    expiry,
  });
  await smartEdit(ctx, text, ckb.proofCancelKb(order.id, lang, true));
  await anchorPaymentMessage(ctx, order.id, ctx.chat!.id);
  bybitImmediatePoll(ctx.api);
}

/** Bybit BSC on-chain top-up. Mirrors checkout.buyNowBybitBsc. */
export async function payTopupBybitBsc(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const scratch = readTopupScratch(ctx);
  if (!scratch || scratch.currency !== "USDT") return void (await staleTopupScreen(ctx));

  const rate = await currentUsdtRate();
  const bybitBsc = await resolveBybitBscConfig(prisma);
  if (!bybitBsc.enabled || !rate) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateTopup(ctx, user.id, PaymentMethod.BYBIT_BSC)) return;

  let order: Awaited<ReturnType<typeof createWalletTopupOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: user.id,
        amount: scratch.amount,
        currency: "USDT",
        method: PaymentMethod.BYBIT_BSC,
        rate,
      }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  delete sc(ctx).topupCurrency;
  delete sc(ctx).topupAmount;

  const fxRate = order.fxRate != null ? new Decimal(order.fxRate) : rate;
  const idrLine = ` (≈ ${formatIdr(new Decimal(order.totalAmount).times(fxRate))})`;
  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.BYBIT_BSC_PAYMENT_WINDOW_MINUTES}m`;

  const text = t(ctx, "checkout.bybit_bsc_instructions", {
    code: order.orderCode,
    address: esc(bybitBsc.depositAddress),
    chain: esc(bybitBsc.chain),
    amount: price(order.totalAmount),
    idr_line: idrLine,
    expiry,
  });
  await smartEdit(ctx, text, ckb.proofCancelKb(order.id, lang, true));
  await anchorPaymentMessage(ctx, order.id, ctx.chat!.id);
  bybitBscImmediatePoll(ctx.api);
}

/** NOWPayments hosted USDT invoice top-up. Mirrors checkout.buyNowNowpayments. */
export async function payTopupNowpayments(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const scratch = readTopupScratch(ctx);
  if (!scratch || scratch.currency !== "USDT") return void (await staleTopupScreen(ctx));

  const creds = await getNowpaymentsCreds(prisma);
  const rate = await currentUsdtRate();
  const publicUrl = config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;
  if (!creds || !rate || !publicUrl) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateTopup(ctx, user.id, PaymentMethod.NOWPAYMENTS)) return;

  let order: Awaited<ReturnType<typeof createWalletTopupOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, {
        userId: user.id,
        amount: scratch.amount,
        currency: "USDT",
        method: PaymentMethod.NOWPAYMENTS,
        rate,
      }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  delete sc(ctx).topupCurrency;
  delete sc(ctx).topupAmount;

  // Atomic claim before the external call — same M-6-style guard the product
  // rail uses (checkout.buyNowNowpayments), even though a top-up order has no
  // storefront payView equivalent yet: cheap insurance against a future
  // second caller, and keeps this rail's shape identical to its buyNow* twin.
  const claimSentinel = await claimGatewaySlot(prisma, order.id);
  if (!claimSentinel) {
    logger.warn(`Lost the gateway claim for wallet top-up order ${order.orderCode} to a concurrent request — leaving the order for the other caller to finish instead of creating a second NOWPayments invoice`);
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  let gateway;
  try {
    gateway = await createNowpaymentsInvoice(creds, {
      orderId: order.orderCode,
      amountUsd: order.totalAmount,
      ipnCallbackUrl: `${publicUrl.replace(/\/+$/, "")}/pay/nowpayments/callback`,
    });
    const committed = await commitGatewayResult(prisma, order.id, claimSentinel, { gateway: "nowpayments", ...gateway });
    if (!committed) {
      logger.warn(`Created a NOWPayments invoice for wallet top-up order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
    }
  } catch (err) {
    await releaseGatewaySlot(prisma, order.id, claimSentinel);
    logger.error({ err }, `Failed to create a NOWPayments invoice for wallet top-up order ${order.orderCode} — cancelling the order shell so it doesn't sit as an orphaned pending payment`);
    await prisma.$transaction((tx) => cancelOrder(tx, order!.id, "gateway_create_failed")).catch(() => {});
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES}m`;
  const text = t(ctx, "checkout.nowpayments_instructions", {
    code: order.orderCode,
    amount: price(order.totalAmount),
    expiry,
  });

  const kb = new InlineKeyboard()
    .url(t(ctx, "checkout.nowpayments_open_invoice"), gateway.invoiceUrl)
    .row()
    .text(t(ctx, "checkout.refresh_status_btn"), ckb.cb("checkout", "refresh", order.id))
    .row()
    .text(t(ctx, "checkout.cancel_order"), ckb.cb("checkout", "cancel", order.id))
    .row()
    .text(t(ctx, "menu.main"), ckb.cb("menu", "main"));
  await smartEdit(ctx, text, kb);
  await anchorPaymentMessage(ctx, order.id, ctx.chat!.id);
}

/** QRIS (TokoPay) top-up. Mirrors checkout.buyNowTokopay. */
export async function payTopupTokopay(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const chatId = ctx.chat!.id;
  const scratch = readTopupScratch(ctx);
  if (!scratch || scratch.currency !== "IDR") return void (await staleTopupScreen(ctx));

  const creds = await getTokopayCreds(prisma);
  if (!creds) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateTopup(ctx, user.id, PaymentMethod.TOKOPAY)) return;

  let order: Awaited<ReturnType<typeof createWalletTopupOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: user.id, amount: scratch.amount, currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  delete sc(ctx).topupCurrency;
  delete sc(ctx).topupAmount;

  const adminFee = computeQrisAdminFee(order.totalAmount);
  const chargeAmount = new Decimal(order.totalAmount).plus(adminFee);

  const claimSentinel = await claimGatewaySlot(prisma, order.id);
  if (!claimSentinel) {
    logger.warn(`Lost the gateway claim for wallet top-up order ${order.orderCode} to a concurrent request — leaving the order for the other caller to finish instead of creating a second TokoPay transaction`);
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  let gateway;
  try {
    gateway = await createTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
    const committed = await commitGatewayResult(prisma, order.id, claimSentinel, { gateway: "tokopay", ...gateway });
    if (!committed) {
      logger.warn(`Created a TokoPay transaction for wallet top-up order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
    }
  } catch (err) {
    await releaseGatewaySlot(prisma, order.id, claimSentinel);
    logger.error({ err }, `Failed to create a TokoPay transaction for wallet top-up order ${order.orderCode} — cancelling the order shell so it doesn't sit as an orphaned pending payment`);
    await prisma.$transaction((tx) => cancelOrder(tx, order!.id, "gateway_create_failed")).catch(() => {});
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.PAYMENT_WINDOW_MINUTES}m`;
  const caption = t(ctx, "checkout.qris_instructions", {
    code: order.orderCode,
    subtotal: formatIdr(order.subtotalAmount),
    fee: formatIdr(adminFee),
    amount: formatIdr(chargeAmount),
    expiry,
  });

  const confirmMsgId = ctx.callbackQuery?.message?.message_id ?? ctx.session.menuMsgId;
  ctx.session.qrMsgId = undefined;
  const waitingKb = ckb.qrisWaitingKb(order.id, lang);
  if (gateway.qrLink) {
    try {
      const qrMsg = await ctx.replyWithPhoto(gateway.qrLink, { caption, parse_mode: "HTML", reply_markup: waitingKb });
      ctx.session.menuMsgId = qrMsg.message_id;
      if (confirmMsgId && confirmMsgId !== qrMsg.message_id) {
        try { await ctx.api.deleteMessage(chatId, confirmMsgId); } catch { /* already gone or too old */ }
      }
    } catch (err) {
      logger.error({ err }, `Failed to send the QRIS QR code photo for wallet top-up order ${order.orderCode} — falling back to a text-only instructions bubble`);
      await smartEdit(ctx, caption, waitingKb);
    }
  } else {
    await smartEdit(ctx, caption, waitingKb);
  }
  await anchorPaymentMessage(ctx, order.id, chatId);
}

/** PayDisini top-up. Mirrors checkout.buyNowPaydisini. */
export async function payTopupPaydisini(ctx: MyContext): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const chatId = ctx.chat!.id;
  const scratch = readTopupScratch(ctx);
  if (!scratch || scratch.currency !== "IDR") return void (await staleTopupScreen(ctx));

  const creds = await getPaydisiniCreds(prisma);
  if (!creds) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }
  if (await refuseDuplicateTopup(ctx, user.id, PaymentMethod.PAYDISINI)) return;

  let order: Awaited<ReturnType<typeof createWalletTopupOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: user.id, amount: scratch.amount, currency: "IDR", method: PaymentMethod.PAYDISINI }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  delete sc(ctx).topupCurrency;
  delete sc(ctx).topupAmount;

  const claimSentinel = await claimGatewaySlot(prisma, order.id);
  if (!claimSentinel) {
    logger.warn(`Lost the gateway claim for wallet top-up order ${order.orderCode} to a concurrent request — leaving the order for the other caller to finish instead of creating a second PayDisini transaction`);
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  let gateway;
  try {
    gateway = await createPaydisiniTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
    const committed = await commitGatewayResult(prisma, order.id, claimSentinel, { gateway: "paydisini", ...gateway });
    if (!committed) {
      logger.warn(`Created a PayDisini transaction for wallet top-up order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
    }
  } catch (err) {
    await releaseGatewaySlot(prisma, order.id, claimSentinel);
    logger.error({ err }, `Failed to create a PayDisini transaction for wallet top-up order ${order.orderCode} — cancelling the order shell so it doesn't sit as an orphaned pending payment`);
    await prisma.$transaction((tx) => cancelOrder(tx, order!.id, "gateway_create_failed")).catch(() => {});
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.PAYMENT_WINDOW_MINUTES}m`;
  const caption = t(ctx, "checkout.paydisini_instructions", {
    code: order.orderCode,
    amount: formatIdr(order.totalAmount),
    expiry,
  });

  const confirmMsgId = ctx.callbackQuery?.message?.message_id ?? ctx.session.menuMsgId;
  ctx.session.qrMsgId = undefined;
  const waitingKb = ckb.qrisWaitingKb(order.id, lang);
  if (gateway.qrUrl) {
    try {
      const qrMsg = await ctx.replyWithPhoto(gateway.qrUrl, { caption, parse_mode: "HTML", reply_markup: waitingKb });
      ctx.session.menuMsgId = qrMsg.message_id;
      if (confirmMsgId && confirmMsgId !== qrMsg.message_id) {
        try { await ctx.api.deleteMessage(chatId, confirmMsgId); } catch { /* already gone or too old */ }
      }
    } catch (err) {
      logger.error({ err }, `Failed to send the PayDisini QR code photo for wallet top-up order ${order.orderCode} — falling back to a text-only instructions bubble`);
      await smartEdit(ctx, caption, waitingKb);
    }
  } else {
    await smartEdit(ctx, caption, waitingKb);
  }
  await anchorPaymentMessage(ctx, order.id, chatId);
}
