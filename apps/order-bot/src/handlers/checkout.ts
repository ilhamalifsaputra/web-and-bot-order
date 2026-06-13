/**
 * Checkout flow — port of checkout.py (navigation + payment instructions +
 * countdown/reminder timers). The proof and voucher conversations live in
 * src/conversations/ (they need @grammyjs/conversations).
 *
 * Flow: browse product → pick qty → show_order_confirmation → confirm (pay) →
 * buy_now creates the order → payment instructions → proof upload → admin
 * verification.
 *
 * PTB's JobQueue per-order countdown/reminder jobs become module-level timers
 * keyed by order id, plus an `activePaymentByChat` map reproducing the
 * `payment_order_id` guard (only tick while the user is on that screen).
 */
import { InputFile } from "grammy";
import type { Api } from "grammy";
import fs from "node:fs";
import { config, isBinanceInternalEnabled } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { ensureUtc, localize } from "@app/core/datetime";
import { OrderStatus, OrderCurrency, PaymentMethod, UserRole } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  getOrder,
  getSetting,
  getProduct,
  countAvailableStock,
  getBulkPricingForProduct,
  getVoucherByCode,
  applyVoucherToSubtotal,
  getUser,
  countUserPendingOrders,
  createOrderDirect,
  createInternalOrder,
  setOrderPaymentMessage,
  cancelOrder,
  finalizeOrderPayment,
} from "@app/db";
import type { MyContext } from "../context";
import { smartEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatPrice, formatIdr, priceIdr } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";

const MAX_PENDING_ORDERS = 10;
// USDT figures only (the charged total of Binance orders). Catalog/confirmation
// amounts are central Rupiah — use priceIdr(v, rate).
const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, "USDT", decimals);

function requireUser(ctx: MyContext) {
  const u = ctx.session.dbUser;
  if (!u) throw new Error("checkout handler reached without a registered user");
  return u;
}

// ---------------------------------------------------------------------------
// Payment countdown & reminder timers (replace PTB JobQueue per-order jobs)
// ---------------------------------------------------------------------------

interface OrderTimers {
  interval?: NodeJS.Timeout;
  timeouts: NodeJS.Timeout[];
}
const timersByOrder = new Map<number, OrderTimers>();
/** chatId → orderId currently shown on the payment screen (the PTB guard). */
const activePaymentByChat = new Map<number, number>();

export function setActivePayment(chatId: number, orderId: number): void {
  activePaymentByChat.set(chatId, orderId);
}

/** Clear the chat's active-payment marker (used when leaving the screen). */
export function clearActivePayment(chatId: number): void {
  activePaymentByChat.delete(chatId);
}

/** Remove all scheduled countdown/reminder timers for this order. */
export function cancelPaymentJobs(orderId: number): void {
  const tm = timersByOrder.get(orderId);
  if (!tm) return;
  if (tm.interval) clearInterval(tm.interval);
  for (const to of tm.timeouts) clearTimeout(to);
  timersByOrder.delete(orderId);
}

function formatCountdown(expiresAt: Date): string {
  const remainingMs = ensureUtc(expiresAt).toMillis() - Date.now();
  const totalSecs = Math.max(0, Math.floor(remainingMs / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

interface PaymentJobBase {
  api: Api;
  orderId: number;
  chatId: number;
  lang: string;
  expiresAt: Date;
  binanceId: string;
  menuMsgId: number;
}

function schedulePaymentJobs(base: PaymentJobBase): void {
  cancelPaymentJobs(base.orderId);
  const now = Date.now();
  const expiresMs = ensureUtc(base.expiresAt).toMillis();
  const tm: OrderTimers = { timeouts: [] };

  if ((expiresMs - now) / 1000 > 30) {
    tm.interval = setInterval(() => void countdownTick(base), 30_000);
  }
  const remind2 = expiresMs - 2 * 60_000;
  if (remind2 > now) {
    tm.timeouts.push(setTimeout(() => void paymentReminder(base, 1), remind2 - now));
  }
  const remind1 = expiresMs - 60_000;
  if (remind1 > now) {
    tm.timeouts.push(setTimeout(() => void paymentReminder(base, 2), remind1 - now));
  }
  timersByOrder.set(base.orderId, tm);
}

async function countdownTick(base: PaymentJobBase): Promise<void> {
  if (Date.now() >= ensureUtc(base.expiresAt).toMillis()) {
    cancelPaymentJobs(base.orderId);
    return;
  }
  if (activePaymentByChat.get(base.chatId) !== base.orderId) {
    cancelPaymentJobs(base.orderId);
    return;
  }
  const order = await getOrder(prisma, base.orderId);
  if (order === null || order.status !== OrderStatus.PENDING_PAYMENT) {
    cancelPaymentJobs(base.orderId);
    return;
  }
  const text = coreT("checkout.payment_instructions", base.lang, {
    code: order.orderCode,
    total: price(order.totalAmount, 4),
    binance_id: esc(base.binanceId),
    countdown: formatCountdown(base.expiresAt),
  });
  try {
    await base.api.editMessageText(base.chatId, base.menuMsgId, text, {
      parse_mode: "HTML",
      reply_markup: ckb.paymentInstructionsKb(base.orderId, base.lang),
    });
  } catch (exc) {
    if (!/message is not modified/i.test(String(exc))) {
      logger.debug(`Countdown edit failed for order ${base.orderId}: ${exc}`);
    }
  }
}

async function paymentReminder(base: PaymentJobBase, level: number): Promise<void> {
  const order = await getOrder(prisma, base.orderId);
  if (order === null || order.status !== OrderStatus.PENDING_PAYMENT) return;
  const key = level === 2 ? "checkout.reminder_1min" : "checkout.reminder_2min";
  const text = coreT(key, base.lang, {
    code: order.orderCode,
    total: price(order.totalAmount, 4),
    binance_id: esc(base.binanceId),
  });
  const kb = ckb.paymentInstructionsKb(base.orderId, base.lang);
  // Edit the existing payment-instructions bubble instead of flooding the chat
  // with a new reminder message — consistent with the single-anchor pattern.
  try {
    await base.api.editMessageText(base.chatId, base.menuMsgId, text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return;
  } catch (err) {
    if (/message is not modified/i.test(String(err))) return;
    // Bubble gone or a photo (QR) — fall back to a fresh message.
  }
  try {
    await base.api.sendMessage(base.chatId, text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    logger.warn(`Could not deliver payment reminder for order ${base.orderId}`);
  }
}

// ---------------------------------------------------------------------------
// Payment instructions
// ---------------------------------------------------------------------------

/**
 * Show payment instructions. When reached from a button tap (e.g. the "Confirm"
 * button → buyNow), this EDITS the existing bubble in place rather than posting
 * a new message; on a non-callback path (e.g. /cancel during proof) smartEdit
 * falls back to a fresh send. Schedules the countdown + reminder timers.
 */
export async function sendPaymentInstructions(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const chatId = ctx.chat!.id;

  const order = await getOrder(prisma, orderId);
  if (order === null || order.userId !== info.id) {
    const msg = await ctx.api.sendMessage(chatId, t(ctx, "error.order_not_found"), { parse_mode: "HTML" });
    ctx.session.menuMsgId = msg.message_id;
    return;
  }

  const binanceId = (await getSetting(prisma, "binance_pay_id")) || config.BINANCE_PAY_ID;
  const qrFileId = await getSetting(prisma, "qr");
  const expiresAt = order.expiresAt ? ensureUtc(order.expiresAt).toJSDate() : null;
  const countdown = expiresAt ? formatCountdown(expiresAt) : `${config.PAYMENT_WINDOW_MINUTES}:00`;

  const text = t(ctx, "checkout.payment_instructions", {
    code: order.orderCode,
    total: price(order.totalAmount, 4),
    binance_id: esc(binanceId),
    countdown,
  });

  cancelPaymentJobs(orderId);
  // Clear any stale QR tracking from a previous payment screen before sending a fresh one.
  ctx.session.qrMsgId = undefined;

  // 1) Edit the confirmation bubble in place into the payment instructions
  //    (reuse the message the "Confirm" button sits on). smartEdit falls back
  //    to a fresh send when there's no callback to edit (e.g. /cancel path).
  await smartEdit(ctx, text, ckb.paymentInstructionsKb(orderId, lang));
  const menuMsgId = ctx.session.menuMsgId;

  // 2) A QR image can't live inside an edited text message — send it as a
  //    separate photo just below and track its message_id so cancel can delete it.
  if (qrFileId) {
    try {
      const qrMsg = await ctx.api.sendPhoto(chatId, qrFileId);
      ctx.session.qrMsgId = qrMsg.message_id;
    } catch (err) {
      logger.error({ err }, "Failed to send QR photo");
    }
  } else if (config.BINANCE_QR_PATH && fs.existsSync(config.BINANCE_QR_PATH)) {
    try {
      const qrMsg = await ctx.api.sendPhoto(chatId, new InputFile(config.BINANCE_QR_PATH));
      ctx.session.qrMsgId = qrMsg.message_id;
    } catch (err) {
      logger.error({ err }, "Failed to send QR image");
    }
  }

  // 3) Mark this order as the chat's active payment view + schedule jobs.
  setActivePayment(chatId, orderId);
  if (expiresAt && menuMsgId) {
    schedulePaymentJobs({ api: ctx.api, orderId, chatId, lang, expiresAt, binanceId, menuMsgId });
  }
}

// ---------------------------------------------------------------------------
// Order confirmation (summary before creating the order)
// ---------------------------------------------------------------------------

interface ConfirmRender {
  productName: string;
  unitPrice: Decimal;
  subtotal: Decimal;
  voucherLine: string;
  voucherCode: string;
}

/** Compute the confirmation totals (shared by the inline path + voucher conv). */
async function computeConfirmation(
  ctx: MyContext,
  productId: number,
  quantity: number,
): Promise<ConfirmRender | null> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const product = await getProduct(prisma, productId);
  if (product === null) return null;
  const bulkRule = await getBulkPricingForProduct(prisma, productId);

  const isReseller = info.role === UserRole.RESELLER;
  const unitPrice = new Decimal(
    isReseller && product.resellerPrice != null ? product.resellerPrice : product.price,
  );
  let subtotal = unitPrice.times(quantity);
  if (bulkRule && quantity >= bulkRule.minQuantity) {
    subtotal = subtotal.times(new Decimal(1).minus(new Decimal(bulkRule.discountPercent).div(100)));
  }

  let voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? "";
  let voucherLine = "";
  if (voucherCode) {
    try {
      const voucherObj = await getVoucherByCode(prisma, voucherCode);
      if (voucherObj) {
        const discount = applyVoucherToSubtotal(voucherObj, subtotal);
        voucherLine = coreT("checkout.confirm_voucher_line", lang, {
          code: voucherCode,
          discount: formatIdr(discount),
        });
        subtotal = subtotal.minus(discount);
      } else {
        delete ctx.session.scratch.appliedVoucherCode;
        voucherCode = "";
      }
    } catch {
      delete ctx.session.scratch.appliedVoucherCode;
      voucherCode = "";
    }
  }

  return { productName: product.name, unitPrice, subtotal, voucherLine, voucherCode };
}

export async function showOrderConfirmation(
  ctx: MyContext,
  productId: number,
  quantity: number,
): Promise<void> {
  const lang = ctx.session.lang;

  const product = await getProduct(prisma, productId);
  if (product === null) {
    // Product vanished between render and tap. Toast for immediacy, then edit
    // the stale "Confirm & Pay" bubble into a recovery screen so the dead
    // confirm button is replaced by a forward action (never strand the user).
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const stock = await countAvailableStock(prisma, productId);
  if (stock < quantity) {
    // Stock disappeared under the user. Toast, then replace the now-invalid
    // confirmation bubble with an out-of-stock notice + a forward action so the
    // dead "Confirm & Pay" button is gone (never strand the user).
    if (ctx.callbackQuery)
      await ctx.answerCallbackQuery({ text: t(ctx, "error.out_of_stock", { product: product.name }), show_alert: true });
    await smartEdit(
      ctx,
      t(ctx, "error.out_of_stock", { product: esc(product.name) }),
      ckb.backToMain(lang),
    );
    return;
  }

  const r = await computeConfirmation(ctx, productId, quantity);
  if (!r) return;

  const rate = await currentUsdtRate();
  await smartEdit(
    ctx,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      total: priceIdr(r.subtotal, rate),
    }),
    ckb.orderConfirmKb(productId, quantity, lang, r.voucherCode, isBinanceInternalEnabled() && rate !== null),
  );
}

/** Re-render confirmation as a fresh message (used after voucher entry). */
export async function renderOrderConfirmation(
  ctx: MyContext,
  productId: number,
  quantity: number,
): Promise<void> {
  const lang = ctx.session.lang;
  const r = await computeConfirmation(ctx, productId, quantity);
  if (!r) return;
  const rate = await currentUsdtRate();
  const msg = await ctx.api.sendMessage(
    ctx.chat!.id,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      total: priceIdr(r.subtotal, rate),
    }),
    { parse_mode: "HTML", reply_markup: ckb.orderConfirmKb(productId, quantity, lang, r.voucherCode, isBinanceInternalEnabled() && rate !== null) },
  );
  ctx.session.menuMsgId = msg.message_id;
}

// ---------------------------------------------------------------------------
// Direct buy: create order → show payment instructions
// ---------------------------------------------------------------------------

export async function buyNow(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? null;
  delete ctx.session.scratch.appliedVoucherCode;

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  const pendingCount = await countUserPendingOrders(prisma, info.id);
  if (pendingCount >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }

  // Binance Pay charges USDT — the central-IDR total converts once at the
  // usd_idr_rate (plan.md §15.4). No rate ⇒ the USDT path is off.
  const rate = await currentUsdtRate();
  if (!rate) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  let order: Awaited<ReturnType<typeof createOrderDirect>>;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode });
      if (!created) return created;
      return finalizeOrderPayment(tx, created.id, {
        currency: OrderCurrency.USDT,
        rate,
        method: PaymentMethod.BINANCE_PAY,
      });
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }

  if (order) await sendPaymentInstructions(ctx, order.id);
}

/**
 * Binance Internal Transfer: create the order, show UID + note instructions
 * (edited in place), and store the message anchor so the poller can edit it to
 * a success message once the transfer is auto-confirmed.
 */
export async function buyNowInternal(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const rate = await currentUsdtRate();
  if (!isBinanceInternalEnabled() || !rate) {
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }
  const voucherCode = (ctx.session.scratch.appliedVoucherCode as string | undefined) ?? null;
  delete ctx.session.scratch.appliedVoucherCode;

  const user = await getUser(prisma, info.id);
  if (user === null) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }
  const pendingCount = await countUserPendingOrders(prisma, info.id);
  if (pendingCount >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }

  let order: Awaited<ReturnType<typeof createInternalOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createInternalOrder(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode, rate }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order || !order.paymentRef) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }

  // The charged amount is USDT; show the central-IDR equivalent beside it
  // (totalAmount × the fxRate snapshot, which includes the unique cents).
  const fxRate = order.fxRate != null ? new Decimal(order.fxRate) : rate;
  const idrLine = ` (≈ ${formatIdr(new Decimal(order.totalAmount).times(fxRate))})`;
  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.INTERNAL_PAYMENT_WINDOW_MINUTES}m`;

  const text = t(ctx, "checkout.internal_instructions", {
    code: order.paymentRef,
    uid: esc(config.BINANCE_RECEIVE_UID ?? ""),
    note: order.paymentRef,
    amount: price(order.totalAmount, 4),
    idr_line: idrLine,
    expiry,
  });
  await smartEdit(ctx, text, ckb.proofCancelKb(order.id, lang));
  // Anchor the instructions message so the poller can flip it to success.
  if (ctx.session.menuMsgId) await setOrderPaymentMessage(prisma, order.id, ctx.chat!.id, ctx.session.menuMsgId);
}

// ---------------------------------------------------------------------------
// Order cancellation (user-initiated, before delivery)
// ---------------------------------------------------------------------------

export async function cancelPendingOrder(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const order = await getOrder(prisma, orderId);
  if (order === null || order.userId !== info.id) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.order_not_found"), show_alert: true });
    return;
  }
  try {
    await prisma.$transaction((tx) => cancelOrder(tx, orderId, "user_cancelled"));
  } catch (e) {
    if (e instanceof ValidationError) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, e.key, e.formatArgs), show_alert: true });
      return;
    }
    throw e;
  }

  const chatId = ctx.chat!.id;
  clearActivePayment(chatId);
  cancelPaymentJobs(orderId);

  // Delete the QR code photo that was sent alongside payment instructions.
  const qrMsgId = ctx.session.qrMsgId;
  if (qrMsgId) {
    ctx.session.qrMsgId = undefined;
    try { await ctx.api.deleteMessage(chatId, qrMsgId); } catch { /* already gone or too old */ }
  }

  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "checkout.cancelled_toast") });

  // Edit the bubble that owned the Cancel button into a confirmation reply,
  // instead of leaving the stale payment screen behind. smartEdit edits on a
  // callback tap and gracefully falls back to a fresh send on the /cancel text
  // path (or when the bubble can't be edited, e.g. a photo+caption QR screen).
  await smartEdit(
    ctx,
    t(ctx, "checkout.order_cancelled", { code: order.orderCode }),
    ckb.notificationKb(lang),
  );
}
