/**
 * TokoPay (QRIS / IDR) reconcile poller.
 *
 * QRIS orders are normally confirmed by the storefront webhook
 * (`/pay/tokopay/callback` → `deliverPaidTokopayOrder`). But that webhook only
 * fires if TokoPay can reach the app (public HTTPS + Callback URL set). When it
 * can't, orders sit `PENDING_PAYMENT` and auto-cancel. This poller is the safety
 * net: each cycle it asks the gateway for the status of every pending TokoPay
 * order and confirms the paid ones.
 *
 * It does NOT DM the buyer directly — `deliverPaidTokopayOrder` enqueues
 * `ORDER_DELIVERED_DM`, and the notifier sends the account `.txt`. That keeps a
 * single delivery path (webhook OR poller → outbox → notifier) with the outbox
 * row's status as the idempotency gate, so the buyer is never double-delivered.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The only gateway call is `checkTransaction` (GET /v1/order, idempotent on
 * ref_id). It never creates or mutates anything on TokoPay's side.
 */
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { PaymentMethod, langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { t as coreT } from "@app/core/i18n";
import { checkTransaction } from "@app/core/payments/tokopay";
import {
  prisma,
  getTokopayCreds,
  listPendingTokopayOrders,
  deliverPaidTokopayOrder,
  listDeliveredOrdersAwaitingEdit,
  clearOrderPaymentMessage,
} from "@app/db";
import { esc } from "../util/format";
import { paymentSuccessKb } from "../keyboards/customer";

type PendingOrder = Awaited<ReturnType<typeof listPendingTokopayOrders>>[number];

type AnchoredOrder = {
  id: number;
  orderCode: string;
  paymentMsgChatId: bigint | null;
  paymentMsgId: number | null;
  user: { language: string };
};

/**
 * Flip the anchored QR bubble to a success message. Best-effort: a photo
 * bubble edits its caption; a text-fallback bubble edits its text. Never throws.
 */
async function editBubbleToSuccess(api: Api, order: AnchoredOrder): Promise<void> {
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return;
  const lang = langCode(order.user.language);
  const chatId = Number(order.paymentMsgChatId);
  const text = coreT("checkout.qris_paid", lang, { code: order.orderCode });
  const markup = paymentSuccessKb(lang);
  try {
    await api.editMessageCaption(chatId, order.paymentMsgId, { caption: text, parse_mode: "HTML", reply_markup: markup });
  } catch {
    try {
      await api.editMessageText(chatId, order.paymentMsgId, text, { parse_mode: "HTML", reply_markup: markup });
    } catch {
      /* bubble gone/uneditable — the credential DM already informed the buyer */
    }
  }
}

/**
 * Sweep DELIVERED TokoPay orders whose bubble hasn't been flipped yet (catches
 * webhook deliveries). Idempotent: clears the anchor after editing so a re-run
 * is a no-op.
 */
export async function sweepDeliveredAwaitingEdit(api: Api): Promise<void> {
  const orders = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.TOKOPAY);
  for (const order of orders) {
    await editBubbleToSuccess(api, order);
    await clearOrderPaymentMessage(prisma, order.id);
  }
}

async function alertAdmins(api: Api, text: string): Promise<void> {
  for (const adminId of adminIds()) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, `admin alert to ${adminId} failed`);
    }
  }
}

/**
 * Reconcile one pending order against the gateway. Confirms (delivers) when the
 * gateway reports it paid for at least the order total. Extracted from the loop
 * so it can be unit-tested with `checkTransaction` stubbed.
 */
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getTokopayCreds>>, order: PendingOrder): Promise<void> {
  if (!creds) return;
  let status: Awaited<ReturnType<typeof checkTransaction>>;
  try {
    status = await checkTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
  } catch (err) {
    logger.warn({ err }, `TokoPay status check failed for ${order.orderCode}`);
    return;
  }
  if (!status.paid) return;

  // Paid but short — never deliver on an underpayment; leave for manual review.
  if (status.amount.lessThan(new Decimal(order.totalAmount))) {
    logger.warn(`TokoPay reconcile: ${order.orderCode} paid ${status.amount} < total ${order.totalAmount} — skipping`);
    return;
  }

  try {
    const r = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: status.trxId ?? `reconcile-${order.orderCode}`,
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`TokoPay reconcile → delivered ${order.orderCode} (notifier will DM the account file)`);
      await editBubbleToSuccess(api, r.order);
      await clearOrderPaymentMessage(prisma, r.order.id);
    } else if (r.status === "stale") {
      logger.warn(`TokoPay reconcile: ${order.orderCode} no longer pending (already handled?)`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `TokoPay reconcile delivery FAILED for ${order.orderCode}`);
    await alertAdmins(api, `⚠️ TokoPay paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
  }
}

export async function pollOnce(api: Api): Promise<void> {
  const creds = await getTokopayCreds(prisma);
  if (!creds) return;

  const orders = await listPendingTokopayOrders(prisma, new Date());
  if (!orders.length) return;
  logger.info(`TokoPay reconcile: checking ${orders.length} pending order(s)`);

  for (const order of orders) {
    await reconcileOrder(api, creds, order);
  }

  // Catches orders the storefront webhook delivered (the bubble flip never
  // happens on the web — CLAUDE.md "never send Telegram from the web").
  await sweepDeliveredAwaitingEdit(api);
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors the other
// poll modules so enabling/disabling TokoPay in Settings takes effect without a
// restart (each cycle re-checks getTokopayCreds).
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | undefined;
let isRunning = false;
let stopped = false;

export function startPolling(api: Api): void {
  stopped = false;
  const intervalMs = config.POLL_INTERVAL_SECONDS * 1000;
  const tick = async () => {
    if (stopped) return;
    if (!isRunning) {
      isRunning = true;
      try {
        await pollOnce(api);
      } catch (err) {
        logger.error({ err }, "TokoPay reconcile cycle error");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void getTokopayCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("TokoPay reconcile disabled (no merchant/secret in Settings or .env) — poller idle");
      return;
    }
    logger.info(`TokoPay reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
