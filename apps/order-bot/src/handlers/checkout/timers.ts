/**
 * Payment countdown & reminder timers (extracted from handlers/checkout.ts,
 * A-02). Replaces PTB's JobQueue per-order jobs with module-level timers keyed
 * by order id, plus an `activePaymentByChat` map reproducing the
 * `payment_order_id` guard (only tick while the user is on that screen).
 *
 * These module-level maps are the single source of truth for active payment
 * screens; checkout.ts and the conversations import the helpers below so every
 * caller mutates the SAME maps.
 */
import type { Api } from "grammy";
import { ensureUtc } from "@app/core/datetime";
import { OrderStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { prisma, getOrder } from "@app/db";
import { coreT } from "../../util/i18n";
import { esc, formatPrice } from "../../util/format";
import * as ckb from "../../keyboards/customer";

// USDT figures only (the charged total of Binance orders).
const price = (v: Decimal.Value, decimals = 2) => formatPrice(v, "USDT", decimals);

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

export function formatCountdown(expiresAt: Date): string {
  const remainingMs = ensureUtc(expiresAt).toMillis() - Date.now();
  const totalSecs = Math.max(0, Math.floor(remainingMs / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export interface PaymentJobBase {
  api: Api;
  orderId: number;
  chatId: number;
  lang: string;
  expiresAt: Date;
  binanceId: string;
  menuMsgId: number;
  qrPhoto: boolean; // true when menuMsgId is a photo+caption bubble (edit caption, not text)
}

async function editPaymentBubble(
  base: PaymentJobBase,
  text: string,
  kb: ReturnType<typeof ckb.paymentInstructionsKb>,
): Promise<void> {
  if (base.qrPhoto) {
    await base.api.editMessageCaption(base.chatId, base.menuMsgId, {
      caption: text,
      parse_mode: "HTML",
      reply_markup: kb,
    });
  } else {
    await base.api.editMessageText(base.chatId, base.menuMsgId, text, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
  }
}

export function schedulePaymentJobs(base: PaymentJobBase): void {
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
    await editPaymentBubble(base, text, ckb.paymentInstructionsKb(base.orderId, base.lang));
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
    await editPaymentBubble(base, text, kb);
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
