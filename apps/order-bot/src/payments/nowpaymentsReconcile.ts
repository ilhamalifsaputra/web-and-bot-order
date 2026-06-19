/**
 * NOWPayments (USDT crypto invoice) reconcile poller.
 *
 * NOWPayments orders are normally confirmed by the storefront/bot's IPN
 * webhook (`verifyIpn` → `deliverPaidNowpaymentsOrder`). But that webhook only
 * fires if NOWPayments can reach the app (public HTTPS + IPN callback URL
 * set). When it can't, orders sit `PENDING_PAYMENT` and auto-cancel. This
 * poller is the safety net: each cycle it asks the gateway for the status of
 * every pending NOWPayments order and confirms the paid ones.
 *
 * It does NOT DM the buyer directly — `deliverPaidNowpaymentsOrder` enqueues
 * `ORDER_DELIVERED_DM`, and the notifier sends the account `.txt`. That keeps a
 * single delivery path (webhook OR poller → outbox → notifier) with the outbox
 * row's status as the idempotency gate, so the buyer is never double-delivered.
 *
 * ── STATUS SEMANTICS (differs from TokoPay/PayDisini) ──────────────────────
 * TokoPay/PayDisini treat "paid" as a string-allowlist match. NOWPayments'
 * `payment_status` instead moves through a fixed lifecycle —
 * `waiting` → `confirming` → `confirmed` → `sending` → `finished` — with the
 * terminal-but-NOT-success outcomes `partially_paid` / `failed` / `refunded` /
 * `expired`. Only an EXACT `status === "finished"` match means "deliver now";
 * every other value (in-flight OR terminal-non-success, including
 * `partially_paid` which can look "close enough") is "not ready yet" and must
 * be skipped silently — never alert admins for it.
 *
 * ── INVOICE ID ───────────────────────────────────────────────────────────--
 * `getPaymentStatus` needs the gateway's invoice id, which the storefront/bot
 * caches as JSON in `order.paymentRef` (tagged `gateway: "nowpayments"`) once
 * the hosted invoice is created — mirrors TokoPay/PayDisini's paymentRef JSON
 * cache (see apps/storefront/src/routes/checkout.ts `CachedGateway`). An order
 * that hasn't had its invoice created yet (paymentRef still null/unparseable)
 * has nothing to check yet — skip it silently.
 *
 * ── READ-ONLY ──────────────────────────────────────────────────────────────
 * The only gateway call is `getPaymentStatus` (GET /v1/invoice/{id}). It never
 * creates or mutates anything on NOWPayments' side.
 */
import type { Api } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { getPaymentStatus } from "@app/core/payments/nowpayments";
import {
  prisma,
  getNowpaymentsCreds,
  listPendingNowpaymentsOrders,
  deliverPaidNowpaymentsOrder,
} from "@app/db";
import { esc } from "../util/format";

type PendingOrder = Awaited<ReturnType<typeof listPendingNowpaymentsOrders>>[number];

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
 * Pull the NOWPayments invoice id out of the JSON cached in `order.paymentRef`
 * (see module doc — same tagged-JSON convention as TokoPay/PayDisini). Returns
 * null when there's nothing to check yet (invoice not created, or a
 * different gateway's payload from a payment-method switch).
 */
function extractInvoiceId(paymentRef: string | null): string | null {
  if (!paymentRef || !paymentRef.startsWith("{")) return null;
  try {
    const d = JSON.parse(paymentRef) as Record<string, unknown>;
    if (d.gateway !== "nowpayments") return null;
    return typeof d.invoiceId === "string" && d.invoiceId ? d.invoiceId : null;
  } catch {
    return null;
  }
}

/**
 * Reconcile one pending order against the gateway. Confirms (delivers) only on
 * an EXACT `status === "finished"` match — every other status (in-flight:
 * waiting/confirming/confirmed/sending, or terminal-non-success:
 * partially_paid/failed/refunded/expired) is "not ready yet" and skipped
 * silently. Extracted from the loop so it can be unit-tested with
 * `getPaymentStatus` stubbed.
 */
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getNowpaymentsCreds>>, order: PendingOrder): Promise<void> {
  if (!creds) return;

  const invoiceId = extractInvoiceId(order.paymentRef);
  if (!invoiceId) return; // no hosted invoice yet — nothing to reconcile

  let status: Awaited<ReturnType<typeof getPaymentStatus>>;
  try {
    status = await getPaymentStatus(creds, { invoiceId });
  } catch (err) {
    logger.warn({ err }, `NOWPayments status check failed for ${order.orderCode}`);
    return;
  }

  // Exact match only — partially_paid/failed/refunded/expired and the
  // in-flight states (waiting/confirming/confirmed/sending) are all "not
  // ready yet", never an error condition worth alerting on.
  if (status.status !== "finished") return;

  // Paid but short — never deliver on an underpayment; leave for manual review.
  if (status.amount.lessThan(new Decimal(order.totalAmount))) {
    logger.warn(`NOWPayments reconcile: ${order.orderCode} paid ${status.amount} < total ${order.totalAmount} — skipping`);
    return;
  }

  try {
    const r = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: status.trxId ?? `reconcile-${order.orderCode}`,
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`NOWPayments reconcile → delivered ${order.orderCode} (notifier will DM the account file)`);
    } else if (r.status === "stale") {
      logger.warn(`NOWPayments reconcile: ${order.orderCode} no longer pending (already handled?)`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `NOWPayments reconcile delivery FAILED for ${order.orderCode}`);
    await alertAdmins(api, `⚠️ NOWPayments paid but delivery FAILED for <code>${esc(order.orderCode)}</code> (out of stock?). Manual action needed.`);
  }
}

export async function pollOnce(api: Api): Promise<void> {
  const creds = await getNowpaymentsCreds(prisma);
  if (!creds) return;

  const orders = await listPendingNowpaymentsOrders(prisma, new Date());
  if (!orders.length) return;
  logger.info(`NOWPayments reconcile: checking ${orders.length} pending order(s)`);

  for (const order of orders) {
    await reconcileOrder(api, creds, order);
  }
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors the other
// poll modules so enabling/disabling NOWPayments in Settings takes effect
// without a restart (each cycle re-checks getNowpaymentsCreds).
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
        logger.error({ err }, "NOWPayments reconcile cycle error");
      } finally {
        isRunning = false;
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void getNowpaymentsCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("NOWPayments reconcile disabled (no api key/ipn secret in Settings or .env) — poller idle");
      return;
    }
    logger.info(`NOWPayments reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  timer = setTimeout(tick, intervalMs);
}

export function stopPolling(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = undefined;
}
