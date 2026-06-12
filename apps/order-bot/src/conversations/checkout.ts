/**
 * Checkout conversations — port of the proof-upload + voucher-entry
 * ConversationHandlers from checkout.py.
 *
 * Replay-safety: DB reads that precede a further wait() are wrapped in
 * conversation.external(); terminal mutations (followed by return, no more
 * waits) run once and may call handler helpers directly.
 */
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { prisma, attachPaymentProof, getVoucherByCode, applyVoucherToSubtotal } from "@app/db";
import type { InlineKeyboard } from "grammy";
import type { MyContext, MyConversation } from "../context";
import { smartEdit } from "../util/chat";
import { coreT, t } from "../util/i18n";
import { esc, formatPrice } from "../util/format";
import { validateTxid } from "../util/validators";
import * as ckb from "../keyboards/customer";
import * as akb from "../keyboards/admin";
import {
  sendPaymentInstructions,
  cancelPendingOrder,
  renderOrderConfirmation,
  cancelPaymentJobs,
  clearActivePayment,
} from "../handlers/checkout";
import { startCommand, showMainMenu } from "../handlers/customer";

// Bot orders are charged in USDT (Binance) — totals here are USDT figures.
const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, "USDT", decimals);

function isCmd(ctx: MyContext, cmd: string): boolean {
  const text = ctx.message?.text ?? "";
  return text === `/${cmd}` || text.startsWith(`/${cmd} `) || text.startsWith(`/${cmd}@`);
}

// ===========================================================================
// Proof: I've Paid → screenshot → TxID → attach + notify admins
// ===========================================================================

export async function proofConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const orderId = parseInt((ctx.callbackQuery?.data ?? "").split(":").at(-1)!, 10);
  const chatId = ctx.chat!.id;

  // The single bubble we keep editing through the whole proof flow — it starts
  // as the payment-instructions message the "I've Paid" button sits on. Each
  // step (screenshot prompt → TxID prompt → result) edits it in place instead
  // of posting new messages. Falls back to a fresh send if the bubble can't be
  // edited (e.g. it was a photo) — then keeps editing that new message.
  let promptMsgId = ctx.callbackQuery?.message?.message_id;
  const editPrompt = async (text: string, kb: InlineKeyboard): Promise<void> => {
    if (promptMsgId !== undefined) {
      try {
        await ctx.api.editMessageText(chatId, promptMsgId, text, { parse_mode: "HTML", reply_markup: kb });
        return;
      } catch (e) {
        if (/message is not modified/i.test(String(e))) return;
        // fall through to a fresh send
      }
    }
    const m = await ctx.api.sendMessage(chatId, text, { parse_mode: "HTML", reply_markup: kb });
    promptMsgId = m.message_id;
  };

  // User is actively uploading proof — stop the countdown/reminders.
  clearActivePayment(chatId);
  cancelPaymentJobs(orderId);
  await ctx.answerCallbackQuery();
  await editPrompt(t(ctx, "checkout.ask_screenshot"), ckb.proofCancelKb(orderId, lang));

  // --- AWAITING_SCREENSHOT ---
  let fileId: string | undefined;
  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:checkout:cancel:")) {
      await cancelPendingOrder(u, orderId);
      return;
    }
    if (data === "v1:menu:main") {
      // Non-destructive escape: leave the order pending (reachable under My
      // Orders) and exit to the dashboard. Must answer the callback here — the
      // conversation owns this update, so the router never sees it (§8.7).
      await u.answerCallbackQuery();
      await showMainMenu(u);
      return;
    }
    if (data.startsWith("v1:checkout:proof:")) {
      await u.answerCallbackQuery();
      await editPrompt(t(u, "checkout.ask_screenshot"), ckb.proofCancelKb(orderId, lang));
      continue;
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      await sendPaymentInstructions(u, orderId);
      return;
    }
    const photos = u.message?.photo;
    if (photos && photos.length) {
      fileId = photos.at(-1)!.file_id;
      break;
    }
    await editPrompt(t(u, "checkout.ask_screenshot"), ckb.proofCancelKb(orderId, lang));
  }

  await editPrompt(t(ctx, "checkout.ask_txid"), ckb.proofCancelKb(orderId, lang));

  // --- AWAITING_TXID ---
  let txid: string;
  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:checkout:cancel:")) {
      await cancelPendingOrder(u, orderId);
      return;
    }
    if (data === "v1:menu:main") {
      // Same non-destructive escape as the screenshot step (§8.7).
      await u.answerCallbackQuery();
      await showMainMenu(u);
      return;
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      await sendPaymentInstructions(u, orderId);
      return;
    }
    const text = u.message?.text;
    if (!text) continue;
    try {
      txid = validateTxid(text);
      break;
    } catch (e) {
      if (e instanceof ValidationError) {
        await editPrompt(t(u, e.key, e.formatArgs), ckb.proofCancelKb(orderId, lang));
        continue;
      }
      throw e;
    }
  }

  // Finalize (terminal — runs once).
  let orderCode: string;
  let buyerTgId: bigint;
  let total: Decimal.Value;
  try {
    const order = await attachPaymentProof(prisma, orderId, { fileId, txid });
    if (!order) {
      await editPrompt(t(ctx, "error.generic"), ckb.backToMain(lang));
      return;
    }
    orderCode = order.orderCode;
    buyerTgId = order.user.telegramId ?? BigInt(0);
    total = order.totalAmount;
  } catch (e) {
    if (e instanceof ValidationError) {
      await editPrompt(t(ctx, e.key, e.formatArgs), ckb.backToMain(lang));
      return;
    }
    throw e;
  }

  await editPrompt(t(ctx, "checkout.proof_submitted", { code: orderCode }), ckb.backToMain(lang));

  for (const adminId of config.ADMIN_IDS) {
    try {
      await ctx.api.sendMessage(
        adminId,
        `🔔 New payment proof submitted\n` +
          `Order: <code>${orderCode}</code>\n` +
          `User: <code>${buyerTgId}</code>\n` +
          `Total: <b>${price(total, 4)}</b>\n` +
          `TxID: <code>${esc(txid)}</code>`,
        { parse_mode: "HTML", reply_markup: akb.verificationActionsKb(orderId, "en") },
      );
    } catch (err) {
      logger.error({ err }, `Failed to notify admin ${adminId} about new proof`);
    }
  }
}

// ===========================================================================
// Voucher: Apply Voucher → enter code → validate → re-render confirmation
// ===========================================================================

export async function voucherConversation(conversation: MyConversation, ctx: MyContext): Promise<void> {
  const lang = ctx.session.lang;
  const parts = (ctx.callbackQuery?.data ?? "").split(":");
  const productId = parseInt(parts[3]!, 10);
  const qty = parseInt(parts[4]!, 10);

  await ctx.answerCallbackQuery();
  await smartEdit(ctx, t(ctx, "checkout.enter_voucher"), ckb.voucherCancelKb(productId, qty, lang));

  for (;;) {
    const u = await conversation.wait();
    const data = u.callbackQuery?.data ?? "";
    if (data.startsWith("v1:buy:")) {
      // voucher_cancel_kb routes to v1:buy — let the router re-render confirmation.
      await u.answerCallbackQuery();
      await renderOrderConfirmation(u, productId, qty);
      return;
    }
    if (isCmd(u, "start")) {
      await startCommand(u);
      return;
    }
    if (isCmd(u, "cancel")) {
      await renderOrderConfirmation(u, productId, qty);
      return;
    }
    const text = u.message?.text;
    if (!text) continue;

    const rawCode = text.trim().toUpperCase();
    const promptAgain = (errKey: string, args: Record<string, unknown> = {}) =>
      `${coreT(errKey, lang, args)}\n\n${coreT("checkout.enter_voucher", lang)}`;

    if (!rawCode || rawCode.length > 32) {
      await u.reply(promptAgain("error.invalid_voucher_code"), {
        parse_mode: "HTML",
        reply_markup: ckb.voucherCancelKb(productId, qty, lang),
      });
      continue;
    }

    const voucher = await conversation.external(() => getVoucherByCode(prisma, rawCode));
    if (voucher === null) {
      await u.reply(promptAgain("error.voucher_not_found"), {
        parse_mode: "HTML",
        reply_markup: ckb.voucherCancelKb(productId, qty, lang),
      });
      continue;
    }
    try {
      // Sanity-check validity with a large subtotal so min_purchase doesn't trip.
      applyVoucherToSubtotal(voucher, new Decimal("999999"));
    } catch (e) {
      if (e instanceof ValidationError) {
        await u.reply(promptAgain(e.key, e.formatArgs), {
          parse_mode: "HTML",
          reply_markup: ckb.voucherCancelKb(productId, qty, lang),
        });
        continue;
      }
      throw e;
    }

    u.session.scratch.appliedVoucherCode = rawCode;
    await renderOrderConfirmation(u, productId, qty);
    return;
  }
}
