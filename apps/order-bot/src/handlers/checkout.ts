/**
 * Checkout flow — port of checkout.py (navigation + the auto-confirm payment
 * rails). The voucher conversation lives in src/conversations/ (it needs
 * @grammyjs/conversations).
 *
 * Flow: browse product → pick qty → show_order_confirmation → pick a gateway
 * (QRIS/PayDisini/USDT) → buyNow<Rail> creates the order and shows that rail's
 * instructions. Every rail auto-confirms and delivers on its own; the legacy
 * manual Binance-Pay proof/verification path is retired.
 */
import { InlineKeyboard } from "grammy";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { localize } from "@app/core/datetime";
import { OrderCurrency, OrderStatus, PaymentMethod, UserRole } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import {
  prisma,
  getOrder,
  getDenomination,
  countAvailableStock,
  getBulkPricingForDenomination,
  getVoucherByCode,
  applyVoucherToSubtotal,
  getUser,
  countUserPendingOrders,
  createOrderDirect,
  createInternalOrder,
  createBybitOrder,
  resolveBybitConfig,
  resolveBinanceInternalConfig,
  setOrderPaymentMessage,
  cancelOrder,
  finalizeOrderPayment,
  getTokopayCreds,
  getPaydisiniCreds,
  getNowpaymentsCreds,
} from "@app/db";
import { createTransaction } from "@app/core/payments/tokopay";
import { createTransaction as createPaydisiniTransaction } from "@app/core/payments/paydisini";
import { createInvoice as createNowpaymentsInvoice } from "@app/core/payments/nowpayments";
import { pollOnce as tokopayPoll } from "../payments/tokopayReconcile";
import { pollOnce as paydisiniPoll } from "../payments/paydisiniReconcile";
import { pollOnce as internalPoll } from "../payments/binanceInternal";
import { pollOnce as bybitPoll } from "../payments/bybitDeposit";
import { pollOnce as nowpaymentsPoll } from "../payments/nowpaymentsReconcile";
import type { MyContext } from "../context";
import { smartEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatPrice, formatIdr, priceIdr } from "../util/format";
import { currentUsdtRate } from "../util/rate";
import * as ckb from "../keyboards/customer";
import * as customer from "./customer";
import {
  setActivePayment,
  clearActivePayment,
  cancelPaymentJobs,
} from "./checkout/timers";

// Re-export the timer surface so `import * as checkout` callers (callbacks,
// conversations) keep working unchanged after the A-02 extraction.
export { setActivePayment, clearActivePayment, cancelPaymentJobs };

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

  const product = await getDenomination(prisma, productId);
  if (product === null) return null;
  const bulkRule = await getBulkPricingForDenomination(prisma, productId);

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

  const product = await getDenomination(prisma, productId);
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
  const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
  const bybitEnabled = (await resolveBybitConfig(prisma)).enabled;
  const tokopayEnabled = (await getTokopayCreds(prisma)) != null;
  const paydisiniEnabled = (await getPaydisiniCreds(prisma)) != null;
  const nowpaymentsEnabled = (await getNowpaymentsCreds(prisma)) != null;
  await smartEdit(
    ctx,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      total: priceIdr(r.subtotal, rate),
    }),
    ckb.orderConfirmKb(
      productId,
      quantity,
      lang,
      r.voucherCode,
      binanceEnabled && rate !== null,
      bybitEnabled && rate !== null,
      tokopayEnabled,
      paydisiniEnabled,
      nowpaymentsEnabled && rate !== null,
    ),
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
  const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
  const bybitEnabled = (await resolveBybitConfig(prisma)).enabled;
  const tokopayEnabled = (await getTokopayCreds(prisma)) != null;
  const paydisiniEnabled = (await getPaydisiniCreds(prisma)) != null;
  const nowpaymentsEnabled = (await getNowpaymentsCreds(prisma)) != null;
  const msg = await ctx.api.sendMessage(
    ctx.chat!.id,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      total: priceIdr(r.subtotal, rate),
    }),
    {
      parse_mode: "HTML",
      reply_markup: ckb.orderConfirmKb(
        productId,
        quantity,
        lang,
        r.voucherCode,
        binanceEnabled && rate !== null,
        bybitEnabled && rate !== null,
        tokopayEnabled,
        paydisiniEnabled,
        nowpaymentsEnabled && rate !== null,
      ),
    },
  );
  ctx.session.menuMsgId = msg.message_id;
}

/**
 * USDT payment submenu — keeps the order-summary bubble but swaps the keyboard
 * for the USDT rails (Binance Transfer / Bybit). Reached from the "USDT" entry
 * on the confirmation screen; Back returns to {@link showOrderConfirmation}.
 */
export async function showUsdtMethods(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const lang = ctx.session.lang;

  const product = await getDenomination(prisma, productId);
  if (product === null) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.try_again"), show_alert: true });
    await smartEdit(ctx, t(ctx, "error.try_again"), ckb.backToMain(lang));
    return;
  }
  const r = await computeConfirmation(ctx, productId, quantity);
  if (!r) return;

  const rate = await currentUsdtRate();
  const binanceEnabled = (await resolveBinanceInternalConfig(prisma)).enabled;
  const bybitEnabled = (await resolveBybitConfig(prisma)).enabled;
  const nowpaymentsEnabled = (await getNowpaymentsCreds(prisma)) != null;
  await smartEdit(
    ctx,
    t(ctx, "checkout.confirm_order", {
      product: esc(r.productName),
      qty: quantity,
      unit_price: priceIdr(r.unitPrice, rate),
      voucher_line: r.voucherLine,
      total: priceIdr(r.subtotal, rate),
    }),
    ckb.usdtMethodsKb(
      productId,
      quantity,
      lang,
      binanceEnabled && rate !== null,
      bybitEnabled && rate !== null,
      nowpaymentsEnabled && rate !== null,
    ),
  );
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
  const cfg = await resolveBinanceInternalConfig(prisma);
  if (!cfg.enabled || !rate) {
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
    uid: esc(cfg.receiveUid),
    note: order.paymentRef,
    amount: price(order.totalAmount, 4),
    idr_line: idrLine,
    expiry,
  });
  await smartEdit(ctx, text, ckb.proofCancelKb(order.id, lang, true));
  // Anchor the instructions message so the poller can flip it to success.
  if (ctx.session.menuMsgId) await setOrderPaymentMessage(prisma, order.id, ctx.chat!.id, ctx.session.menuMsgId);
}

/**
 * Bybit USDT-BSC deposit: create the order, show the BEP20 deposit address +
 * the exact amount to send (no memo on BSC — matching is by amount), and anchor
 * the message so the deposit poller can flip it to success on auto-confirm.
 */
export async function buyNowBybit(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const rate = await currentUsdtRate();
  const bybit = await resolveBybitConfig(prisma);
  if (!bybit.enabled || !rate) {
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

  let order: Awaited<ReturnType<typeof createBybitOrder>>;
  try {
    order = await prisma.$transaction((tx) =>
      createBybitOrder(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode, rate }),
    );
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }

  // The charged amount is USDT; show the central-IDR equivalent beside it
  // (totalAmount × the fxRate snapshot, which includes the unique cents).
  const fxRate = order.fxRate != null ? new Decimal(order.fxRate) : rate;
  const idrLine = ` (≈ ${formatIdr(new Decimal(order.totalAmount).times(fxRate))})`;
  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.BYBIT_PAYMENT_WINDOW_MINUTES}m`;

  const text = t(ctx, "checkout.bybit_instructions", {
    code: order.orderCode,
    address: esc(bybit.depositAddress),
    amount: price(order.totalAmount, 4),
    idr_line: idrLine,
    expiry,
  });
  await smartEdit(ctx, text, ckb.proofCancelKb(order.id, lang, true));
  // Anchor the instructions message so the poller can flip it to success.
  if (ctx.session.menuMsgId) await setOrderPaymentMessage(prisma, order.id, ctx.chat!.id, ctx.session.menuMsgId);
}

/** Public origin used for the NOWPayments IPN callback URL (storefront route). */
const shopPublicUrl = (): string | null => config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;

/**
 * NOWPayments (hosted USDT invoice) — third USDT-rail auto-confirm option
 * alongside Binance Internal / Bybit. Same order-creation shape as
 * {@link buyNowInternal}/{@link buyNowBybit} (USDT finalize), but the
 * confirmation screen is a hosted invoice page rather than an address/QR: we
 * render an `InlineKeyboard.url(...)` button that opens it, instead of
 * `sendPhoto`. ⚠ Needs the public callback URL configured (DOCS §15.5) or
 * the order will stall then auto-cancel unless the reconcile poller
 * (`payments/nowpaymentsReconcile.ts`) catches it.
 */
export async function buyNowNowpayments(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;

  const creds = await getNowpaymentsCreds(prisma);
  const rate = await currentUsdtRate();
  const publicUrl = shopPublicUrl();
  if (!creds || !rate || !publicUrl) {
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

  let order: Awaited<ReturnType<typeof createOrderDirect>>;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode });
      if (!created) return created;
      return finalizeOrderPayment(tx, created.id, {
        currency: OrderCurrency.USDT,
        rate,
        method: PaymentMethod.NOWPAYMENTS,
      });
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }

  // Create the hosted invoice + cache it. order.totalAmount is ALREADY in USDT
  // (finalizeOrderPayment's USDT branch) — pass it straight through as
  // amountUsd, no second conversion.
  let gateway;
  try {
    gateway = await createNowpaymentsInvoice(creds, {
      orderId: order.orderCode,
      amountUsd: order.totalAmount,
      ipnCallbackUrl: `${publicUrl.replace(/\/+$/, "")}/pay/nowpayments/callback`,
    });
    // Tagged `gateway: "nowpayments"` to match the cache shape the storefront's
    // own cache-write site produces (apps/storefront/src/routes/checkout.ts) —
    // its parseCachedNowpaymentsGateway() AND the bot's reconcile poller's
    // extractInvoiceId() (payments/nowpaymentsReconcile.ts) both require this
    // discriminator before trusting the cache.
    await prisma.order.update({ where: { id: order.id }, data: { paymentRef: JSON.stringify({ gateway: "nowpayments", ...gateway }) } });
  } catch (err) {
    logger.error({ err }, `NOWPayments create failed for ${order.orderCode}`);
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES}m`;
  const text = t(ctx, "checkout.nowpayments_instructions", {
    code: order.orderCode,
    amount: price(order.totalAmount, 4),
    expiry,
  });

  // No QR/address to render — a hosted invoice is a redirect-UX page, so the
  // payment action is a URL button rather than sendPhoto (the QR/TokoPay/
  // PayDisini pattern doesn't apply here).
  const kb = new InlineKeyboard()
    .url(t(ctx, "checkout.nowpayments_open_invoice"), gateway.invoiceUrl)
    .row()
    .text(t(ctx, "checkout.refresh_status_btn"), ckb.cb("checkout", "refresh", order.id))
    .row()
    .text(t(ctx, "checkout.cancel_order"), ckb.cb("checkout", "cancel", order.id))
    .row()
    .text(t(ctx, "menu.main"), ckb.cb("menu", "main"));
  await smartEdit(ctx, text, kb);
  // Anchor the instructions message so the reconcile poller's admin alerts
  // (and any future success-flip) target the right bubble — mirrors
  // buyNowInternal/buyNowBybit (no setActivePayment/countdown ticking here;
  // that's only for the manual Binance Pay screen).
  if (ctx.session.menuMsgId) await setOrderPaymentMessage(prisma, order.id, ctx.chat!.id, ctx.session.menuMsgId);
}

/**
 * QRIS (TokoPay) — create an IDR order, draw the QR inside Telegram, and let the
 * existing TokoPay webhook auto-confirm. No proof upload. ⚠ Needs the public
 * callback URL configured (DOCS §15.5) or the order will stall then auto-cancel.
 */
export async function buyNowTokopay(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const chatId = ctx.chat!.id;

  const creds = await getTokopayCreds(prisma);
  if (!creds) {
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
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }

  let order: Awaited<ReturnType<typeof createOrderDirect>>;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode });
      if (!created) return created;
      return finalizeOrderPayment(tx, created.id, { currency: OrderCurrency.IDR });
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }

  // Create (idempotent on ref_id) the gateway transaction + cache it.
  let gateway;
  try {
    gateway = await createTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
    // Tagged `gateway: "tokopay"` to match the cache shape the storefront's own
    // cache-write sites produce (apps/storefront/src/routes/checkout.ts) — its
    // parseCachedGateway() requires this discriminator before trusting the cache.
    await prisma.order.update({ where: { id: order.id }, data: { paymentRef: JSON.stringify({ gateway: "tokopay", ...gateway }) } });
  } catch (err) {
    logger.error({ err }, `TokoPay create failed for ${order.orderCode}`);
    await smartEdit(ctx, t(ctx, "checkout.payment_unavailable"), ckb.backToMain(lang));
    return;
  }

  const expiry = order.expiresAt
    ? `${localize(order.expiresAt, "yyyy-LL-dd HH:mm")} WIB`
    : `${config.PAYMENT_WINDOW_MINUTES}m`;
  const caption = t(ctx, "checkout.qris_instructions", {
    code: order.orderCode,
    amount: formatIdr(order.totalAmount),
    expiry,
  });

  // Unify the QR image and the payment instructions into ONE photo+caption
  // bubble (image + caption + waiting keyboard), so the QR reads as part of the
  // same screen instead of a detached photo below. A text confirm bubble can't
  // morph into a photo via edit, so delete it and send the QR fresh, then track
  // it as menuMsgId — smartEdit edits a photo bubble's caption in place, so the
  // cancel/expiry transitions still land on this same bubble.
  const confirmMsgId = ctx.callbackQuery?.message?.message_id ?? ctx.session.menuMsgId;
  ctx.session.qrMsgId = undefined;
  const waitingKb = ckb.qrisWaitingKb(order.id, lang);
  if (gateway.qrLink) {
    try {
      const qrMsg = await ctx.replyWithPhoto(gateway.qrLink, {
        caption,
        parse_mode: "HTML",
        reply_markup: waitingKb,
      });
      ctx.session.menuMsgId = qrMsg.message_id;
      if (confirmMsgId && confirmMsgId !== qrMsg.message_id) {
        try { await ctx.api.deleteMessage(chatId, confirmMsgId); } catch { /* already gone or too old */ }
      }
    } catch (err) {
      logger.error({ err }, "Failed to send QRIS photo");
      // QR image failed — fall back to a text-only instructions bubble.
      await smartEdit(ctx, caption, waitingKb);
    }
  } else {
    await smartEdit(ctx, caption, waitingKb);
  }
  // Anchor whichever bubble (photo or text-fallback) became the wait screen, so
  // the reconcile poller's success-flip sweep can edit it once delivered.
  if (ctx.session.menuMsgId) await setOrderPaymentMessage(prisma, order.id, chatId, ctx.session.menuMsgId);
  setActivePayment(chatId, order.id);
}

/**
 * PayDisini (QRIS / e-wallet) — second IDR auto-confirm rail alongside TokoPay.
 * Same shape as {@link buyNowTokopay}: create an IDR order, draw the QR inside
 * Telegram, and let the storefront's PayDisini webhook (or the bot's reconcile
 * poller, `payments/paydisiniReconcile.ts`) auto-confirm. No proof upload.
 * ⚠ Needs the public callback URL configured (DOCS §15.5) or the order will
 * stall then auto-cancel unless the reconcile poller catches it.
 */
export async function buyNowPaydisini(ctx: MyContext, productId: number, quantity: number): Promise<void> {
  const info = requireUser(ctx);
  const lang = ctx.session.lang;
  const chatId = ctx.chat!.id;

  const creds = await getPaydisiniCreds(prisma);
  if (!creds) {
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
  if ((await countUserPendingOrders(prisma, info.id)) >= MAX_PENDING_ORDERS) {
    await smartEdit(ctx, t(ctx, "error.too_many_pending", { limit: MAX_PENDING_ORDERS }), ckb.backToMain(lang));
    return;
  }

  let order: Awaited<ReturnType<typeof createOrderDirect>>;
  try {
    order = await prisma.$transaction(async (tx) => {
      const created = await createOrderDirect(tx, { user: { id: user.id, role: user.role }, productId, quantity, voucherCode });
      if (!created) return created;
      return finalizeOrderPayment(tx, created.id, { currency: OrderCurrency.IDR, method: PaymentMethod.PAYDISINI });
    });
  } catch (e) {
    if (e instanceof ValidationError) {
      await smartEdit(ctx, t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }
  if (!order) {
    await smartEdit(ctx, t(ctx, "error.generic"), ckb.backToMain(lang));
    return;
  }

  // Create (idempotent on ref_id) the gateway transaction + cache it.
  let gateway;
  try {
    gateway = await createPaydisiniTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
    // Tagged `gateway: "paydisini"` to match the cache shape the storefront's own
    // cache-write sites produce (apps/storefront/src/routes/checkout.ts) — its
    // parseCachedPaydisiniGateway() requires this discriminator before trusting the cache.
    await prisma.order.update({ where: { id: order.id }, data: { paymentRef: JSON.stringify({ gateway: "paydisini", ...gateway }) } });
  } catch (err) {
    logger.error({ err }, `PayDisini create failed for ${order.orderCode}`);
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

  // Unify the QR image and the payment instructions into ONE photo+caption
  // bubble (image + caption + waiting keyboard), so the QR reads as part of the
  // same screen instead of a detached photo below. A text confirm bubble can't
  // morph into a photo via edit, so delete it and send the QR fresh, then track
  // it as menuMsgId — smartEdit edits a photo bubble's caption in place, so the
  // cancel/expiry transitions still land on this same bubble.
  const confirmMsgId = ctx.callbackQuery?.message?.message_id ?? ctx.session.menuMsgId;
  ctx.session.qrMsgId = undefined;
  const waitingKb = ckb.qrisWaitingKb(order.id, lang);
  if (gateway.qrUrl) {
    try {
      const qrMsg = await ctx.replyWithPhoto(gateway.qrUrl, {
        caption,
        parse_mode: "HTML",
        reply_markup: waitingKb,
      });
      ctx.session.menuMsgId = qrMsg.message_id;
      if (confirmMsgId && confirmMsgId !== qrMsg.message_id) {
        try { await ctx.api.deleteMessage(chatId, confirmMsgId); } catch { /* already gone or too old */ }
      }
    } catch (err) {
      logger.error({ err }, "Failed to send PayDisini QR photo");
      // QR image failed — fall back to a text-only instructions bubble.
      await smartEdit(ctx, caption, waitingKb);
    }
  } else {
    await smartEdit(ctx, caption, waitingKb);
  }
  // Anchor whichever bubble (photo or text-fallback) became the wait screen, so
  // the reconcile poller's success-flip sweep can edit it once delivered.
  if (ctx.session.menuMsgId) await setOrderPaymentMessage(prisma, order.id, chatId, ctx.session.menuMsgId);
  setActivePayment(chatId, order.id);
}

// ---------------------------------------------------------------------------
// Order cancellation (user-initiated, before delivery)
// ---------------------------------------------------------------------------

export async function cancelPendingOrder(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);

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

  // Land the user back on the cancelled order's Product Detail bubble (fresh
  // stock) instead of a transient "cancelled" notice — no stray message, no QR
  // left hanging.
  const denominationId = order.items[0]?.productId;
  if (denominationId === undefined || denominationId === null) {
    // Defensive — an order with no items shouldn't happen. Don't strand the user.
    await customer.showMainMenu(ctx);
    return;
  }

  // The QRIS/payment wait screen is a photo+caption bubble (the QR image); it
  // can't morph into the text Product Detail via edit (smartEdit would
  // editMessageCaption, leaving the QR stuck above the Detail text). Delete it
  // and clear the anchor so Detail sends fresh. A text wait screen (Binance
  // manual / Internal / Bybit / NOWPayments) edits straight to Detail in place.
  const cqMsg = ctx.callbackQuery?.message;
  const wasPhoto = !!(cqMsg && "photo" in cqMsg && cqMsg.photo);
  if (wasPhoto && cqMsg) {
    try {
      await ctx.api.deleteMessage(chatId, cqMsg.message_id);
    } catch {
      /* gone/too old */
    }
    ctx.session.menuMsgId = undefined;
  }

  await customer.browseDenomination(ctx, denominationId, 1, {
    noticePrefix: t(ctx, "checkout.cancelled_prefix"),
  });
}

// ---------------------------------------------------------------------------
// On-demand reconcile ("Refresh Status" button on auto-confirm wait screens)
// ---------------------------------------------------------------------------

/**
 * Trigger an on-demand reconcile for a pending auto-confirm order and toast
 * the result. All five pollers are idempotent (they re-list pending orders
 * and guard on status), so calling one out-of-band of its timer is always
 * safe. This does NOT edit the wait-screen bubble itself — for Internal/Bybit
 * the poller's own onDelivered already flips it (paymentSuccessKb); for
 * TokoPay/PayDisini the live-edit-to-success lands in a later task; NOWPayments
 * never flips. The toast is the immediate feedback in every case.
 */
export async function refreshPaymentStatus(ctx: MyContext, orderId: number): Promise<void> {
  const info = requireUser(ctx);
  const order = await getOrder(prisma, orderId);
  if (!order || order.userId !== info.id) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "error.order_not_found"), show_alert: true });
    return;
  }
  if (order.status !== OrderStatus.PENDING_PAYMENT) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: t(ctx, "checkout.refresh_delivered_toast") });
    return;
  }
  switch (order.paymentMethod) {
    case PaymentMethod.TOKOPAY:
      await tokopayPoll(ctx.api);
      break;
    case PaymentMethod.PAYDISINI:
      await paydisiniPoll(ctx.api);
      break;
    case PaymentMethod.BINANCE_INTERNAL:
      await internalPoll(ctx.api);
      break;
    case PaymentMethod.BYBIT:
      await bybitPoll(ctx.api);
      break;
    case PaymentMethod.NOWPAYMENTS:
      await nowpaymentsPoll(ctx.api);
      break;
    default:
      // Manual Binance Pay has no on-demand check; shouldn't reach here (no button).
      if (ctx.callbackQuery) await ctx.answerCallbackQuery();
      return;
  }
  const after = await getOrder(prisma, orderId);
  const stillPending = !after || after.status === OrderStatus.PENDING_PAYMENT;
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({
      text: t(ctx, stillPending ? "checkout.still_pending_toast" : "checkout.refresh_delivered_toast"),
    });
  }
}
