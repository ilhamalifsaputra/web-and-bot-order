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
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { Decimal } from "@app/core/money";
import { HTTP_TIMEOUT_MS } from "@app/core/http";
import { getPaymentStatus } from "@app/core/payments/nowpayments";
import {
  prisma,
  getNowpaymentsCreds,
  listPendingNowpaymentsOrders,
  deliverPaidNowpaymentsOrder,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { createPollLoop } from "./pollLoop";

type PendingOrder = Awaited<ReturnType<typeof listPendingNowpaymentsOrders>>[number];

async function alertAdmins(api: Api, text: string): Promise<void> {
  for (const adminId of adminIds()) {
    try {
      await api.sendMessage(adminId, text, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, `Failed to send admin alert to admin ${adminId} — they will not see this notification in Telegram`);
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
 *
 * Returns `"gateway_error"` only when the `getPaymentStatus` call itself
 * failed (network/HTTP/parse) — every other outcome, including "no invoice
 * yet" (no gateway call was even made) and a delivery-side throw, is `"ok"`:
 * neither is evidence the gateway is unreachable. `pollOnce` uses this to
 * tell "one flaky order" from "the gateway didn't answer a single call"
 * (Task 11).
 */
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getNowpaymentsCreds>>, order: PendingOrder): Promise<"ok" | "gateway_error"> {
  if (!creds) return "ok";

  const invoiceId = extractInvoiceId(order.paymentRef);
  if (!invoiceId) return "ok"; // no hosted invoice yet — nothing to reconcile

  let status: Awaited<ReturnType<typeof getPaymentStatus>>;
  try {
    status = await getPaymentStatus(creds, { invoiceId });
  } catch (err) {
    logger.warn({ err }, `Failed to check NOWPayments status for order ${order.orderCode} — will retry on the next reconcile cycle`);
    return "gateway_error";
  }

  // Exact match only — partially_paid/failed/refunded/expired and the
  // in-flight states (waiting/confirming/confirmed/sending) are all "not
  // ready yet", never an error condition worth alerting on.
  if (status.status !== "finished") return "ok";

  // Paid but short — never deliver on an underpayment; leave for manual review.
  if (status.amount.lessThan(new Decimal(order.totalAmount))) {
    logger.warn(`Order ${order.orderCode} underpaid — NOWPayments reports ${status.amount}, expected ${order.totalAmount}, left PENDING for manual review`);
    return "ok";
  }

  try {
    const r = await deliverPaidNowpaymentsOrder(prisma, {
      orderId: order.id,
      trxId: status.trxId ?? `reconcile-${order.orderCode}`,
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`NOWPayments reconcile delivered order ${order.orderCode} — nudging notifier to DM the account file immediately`);
      nudgeOutboxDispatcher();
    } else if (r.status === "processing") {
      logger.info(`NOWPayments reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
    } else if (r.status === "stale") {
      logger.warn(`Order ${order.orderCode} was paid but is no longer PENDING — likely already delivered by the webhook, no action needed`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `Order ${order.orderCode} was paid (NOWPayments) but delivery threw — admin alerted for manual action`);
    await alertAdmins(api, `⚠️ NOWPayments paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
  }
  return "ok";
}

/** Cap on how many pending orders one reconcile cycle checks against the
 * gateway, oldest first (closest to auto-cancelling, so a large backlog
 * still gets its most time-sensitive orders checked every cycle instead of
 * one unbounded sequential sweep). Orders beyond the cap simply wait for the
 * next cycle, `POLL_INTERVAL_SECONDS` later: the webhook (IPN) is still the
 * PRIMARY delivery path (see the module doc-comment) — this poller only
 * fills the gap when the webhook can't reach the app, so a capped order
 * waiting one extra cycle only delays the safety net catching it, never the
 * normal delivery path. (Task 11.) */
export const MAX_ORDERS_PER_CYCLE = 50;

// cycleTimeoutMs derivation (Task 3 review follow-up shape — see
// bybitBscConfirmationTracker.ts's TRACKER_CYCLE_TIMEOUT_MS for the worked
// precedent this mirrors): one cycle makes at most MAX_ORDERS_PER_CYCLE
// sequential getPaymentStatus calls, each individually bounded at
// HTTP_TIMEOUT_MS.gatewayRead (10s) — so MAX_ORDERS_PER_CYCLE ×
// HTTP_TIMEOUT_MS.gatewayRead is the raw worst case (500_000ms at today's
// cap/timeout). +30s margin covers the DB list/deliver work around the
// gateway calls each cycle.
const PER_ORDER_WORST_CASE_MS = HTTP_TIMEOUT_MS.gatewayRead;
const CYCLE_TIMEOUT_MARGIN_MS = 30_000;
/** MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS + margin = 530_000 —
 * passed to `createPollLoop` below as this rail's `cycleTimeoutMs`. */
const RECONCILE_CYCLE_TIMEOUT_MS = MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

export async function pollOnce(api: Api): Promise<void> {
  const creds = await getNowpaymentsCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

  const orders = await listPendingNowpaymentsOrders(prisma, new Date(), MAX_ORDERS_PER_CYCLE);
  if (!orders.length) {
    // An empty pending list is a successful cycle, not a skipped one — a
    // healthy shop that's simply quiet must still advance the heartbeat, or
    // it reads as stale after 5 minutes and the Task 12 watchdog pages
    // admins over nothing (Task 11 brief).
    await recordPollHealth(prisma, "nowpayments", { lastTxCount: 0, success: true }).catch(() => undefined);
    return;
  }
  logger.info(`NOWPayments reconcile checking ${orders.length} pending order(s) against the gateway`);

  let gatewayErrors = 0;
  for (const order of orders) {
    const outcome = await reconcileOrder(api, creds, order);
    if (outcome === "gateway_error") gatewayErrors++;
  }

  // A cycle counts as failed only when EVERY gateway call in it failed — one
  // flaky order is normal noise; a gateway that answered zero of N calls is
  // an outage worth surfacing.
  const allFailed = gatewayErrors === orders.length;
  await recordPollHealth(prisma, "nowpayments", {
    lastTxCount: orders.length,
    success: !allFailed,
    error: allFailed
      ? `NOWPayments gateway unreachable — all ${orders.length} pending order status check(s) failed this cycle`
      : null,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors the other
// poll modules so enabling/disabling NOWPayments in Settings takes effect
// without a restart (each cycle re-checks getNowpaymentsCreds).
// ---------------------------------------------------------------------------

// Set by startPolling() before the loop's `run` ever fires — the loop
// itself starts `stopped`, so `run` can never be invoked while this is
// still undefined.
let boundApi: Api | undefined;

// cycleTimeoutMs is RECONCILE_CYCLE_TIMEOUT_MS, sized off MAX_ORDERS_PER_CYCLE's
// own worst case (see the derivation comment above pollOnce) — 530s. Without
// this the default `max(3 * intervalMs, 60_000)` (60s at the default
// POLL_INTERVAL_SECONDS) would abandon a cycle mid-batch long before a full
// MAX_ORDERS_PER_CYCLE sweep of a slow-but-not-hung gateway could finish.
//
// `onCycleTimeout` is intentionally still omitted: this rail now writes a
// real poll-health heartbeat on every normal-path cycle (`recordPollHealth`
// in pollOnce above, Task 11), but wiring that same write into the abandon
// branch too is Task 12's job, alongside the watchdog that reads this
// heartbeat. A hung cycle is not silent in the meantime — pollOnce's own
// heartbeat simply stops advancing, so `lastRun` goes stale past the
// interval, which is exactly the staleness signal a heartbeat-reading
// watchdog checks for.
const loop = createPollLoop({
  name: "NOWPayments reconcile",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: RECONCILE_CYCLE_TIMEOUT_MS,
  run: () => pollOnce(boundApi!),
});

export function startPolling(api: Api): void {
  boundApi = api;
  void getNowpaymentsCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("NOWPayments reconcile disabled (no api key/ipn secret in Settings or .env) — poller idle");
      return;
    }
    logger.info(`NOWPayments reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
