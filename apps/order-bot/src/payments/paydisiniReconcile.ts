/**
 * PayDisini (QRIS / e-wallet) reconcile poller.
 *
 * PayDisini orders are normally confirmed by the storefront webhook
 * (`/pay/paydisini/callback` → `deliverPaidPaydisiniOrder`). But that webhook only
 * fires if PayDisini can reach the app (public HTTPS + Callback URL set). When it
 * can't, orders sit `PENDING_PAYMENT` and auto-cancel. This poller is the safety
 * net: each cycle it asks the gateway for the status of every pending PayDisini
 * order and confirms the paid ones.
 *
 * It does NOT DM the buyer directly — `deliverPaidPaydisiniOrder` enqueues
 * `ORDER_DELIVERED_DM`, and the notifier sends the account `.txt`. That keeps a
 * single delivery path (webhook OR poller → outbox → notifier) with the outbox
 * row's status as the idempotency gate, so the buyer is never double-delivered.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The only gateway call is `checkTransaction` (GET /v1/transaction, idempotent
 * on ref_id). It never creates or mutates anything on PayDisini's side.
 */
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { checkTransaction } from "@app/core/payments/paydisini";
import {
  prisma,
  getPaydisiniCreds,
  listPendingPaydisiniOrders,
  deliverPaidPaydisiniOrder,
} from "@app/db";
import { esc } from "../util/format";

type PendingOrder = Awaited<ReturnType<typeof listPendingPaydisiniOrders>>[number];

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
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getPaydisiniCreds>>, order: PendingOrder): Promise<void> {
  if (!creds) return;
  let status: Awaited<ReturnType<typeof checkTransaction>>;
  try {
    status = await checkTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
  } catch (err) {
    logger.warn({ err }, `PayDisini status check failed for ${order.orderCode}`);
    return;
  }
  if (!status.paid) return;

  // Paid but short — never deliver on an underpayment; leave for manual review.
  if (status.amount.lessThan(new Decimal(order.totalAmount))) {
    logger.warn(`PayDisini reconcile: ${order.orderCode} paid ${status.amount} < total ${order.totalAmount} — skipping`);
    return;
  }

  try {
    const r = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: status.trxId ?? `reconcile-${order.orderCode}`,
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`PayDisini reconcile → delivered ${order.orderCode} (notifier will DM the account file)`);
    } else if (r.status === "stale") {
      logger.warn(`PayDisini reconcile: ${order.orderCode} no longer pending (already handled?)`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `PayDisini reconcile delivery FAILED for ${order.orderCode}`);
    await alertAdmins(api, `⚠️ PayDisini paid but delivery FAILED for <code>${esc(order.orderCode)}</code> (out of stock?). Manual action needed.`);
  }
}

export async function pollOnce(api: Api): Promise<void> {
  const creds = await getPaydisiniCreds(prisma);
  if (!creds) return;

  const orders = await listPendingPaydisiniOrders(prisma, new Date());
  if (!orders.length) return;
  logger.info(`PayDisini reconcile: checking ${orders.length} pending order(s)`);

  for (const order of orders) {
    await reconcileOrder(api, creds, order);
  }
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors the other
// poll modules so enabling/disabling PayDisini in Settings takes effect without a
// restart (each cycle re-checks getPaydisiniCreds).
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
        logger.error({ err }, "PayDisini reconcile cycle error");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void getPaydisiniCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("PayDisini reconcile disabled (no userkey/apikey in Settings or .env) — poller idle");
      return;
    }
    logger.info(`PayDisini reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
