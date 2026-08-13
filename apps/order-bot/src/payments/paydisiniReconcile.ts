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
import { PaymentMethod, langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { Decimal } from "@app/core/money";
import { t as coreT } from "@app/core/i18n";
import { HTTP_TIMEOUT_MS } from "@app/core/http";
import { checkTransaction } from "@app/core/payments/paydisini";
import {
  prisma,
  getPaydisiniCreds,
  listPendingPaydisiniOrders,
  deliverPaidPaydisiniOrder,
  listDeliveredOrdersAwaitingEdit,
  clearOrderPaymentMessage,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { paymentSuccessKb } from "../keyboards/customer";
import { createPollLoop } from "./pollLoop";

type PendingOrder = Awaited<ReturnType<typeof listPendingPaydisiniOrders>>[number];

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
 * Sweep DELIVERED PayDisini orders whose bubble hasn't been flipped yet
 * (catches webhook deliveries). Idempotent: clears the anchor after editing so
 * a re-run is a no-op.
 */
export async function sweepDeliveredAwaitingEdit(api: Api): Promise<void> {
  const orders = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.PAYDISINI);
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
      logger.error({ err }, `Failed to send admin alert to admin ${adminId} — they will not see this notification in Telegram`);
    }
  }
}

/**
 * Reconcile one pending order against the gateway. Confirms (delivers) when the
 * gateway reports it paid for at least the order total. Extracted from the loop
 * so it can be unit-tested with `checkTransaction` stubbed.
 *
 * Returns `"gateway_error"` only when the `checkTransaction` call itself
 * failed (network/HTTP/parse) — every other outcome (unpaid, underpaid,
 * delivered, a delivery-side throw) is `"ok"`: the gateway answered, so it's
 * not evidence the gateway is unreachable. `pollOnce` uses this to tell "one
 * flaky order" from "the gateway didn't answer a single call" (Task 11).
 */
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getPaydisiniCreds>>, order: PendingOrder): Promise<"ok" | "gateway_error"> {
  if (!creds) return "ok";
  let status: Awaited<ReturnType<typeof checkTransaction>>;
  try {
    status = await checkTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
  } catch (err) {
    logger.warn({ err }, `Failed to check PayDisini status for order ${order.orderCode} — will retry on the next reconcile cycle`);
    return "gateway_error";
  }
  if (!status.paid) return "ok";

  // Paid but short — never deliver on an underpayment; leave for manual review.
  if (status.amount.lessThan(new Decimal(order.totalAmount))) {
    logger.warn(`Order ${order.orderCode} underpaid — PayDisini reports ${status.amount}, expected ${order.totalAmount}, left PENDING for manual review`);
    return "ok";
  }

  try {
    const r = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: status.trxId ?? `reconcile-${order.orderCode}`,
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`PayDisini reconcile delivered order ${order.orderCode} — nudging notifier to DM the account file immediately`);
      nudgeOutboxDispatcher();
      await editBubbleToSuccess(api, r.order);
      await clearOrderPaymentMessage(prisma, r.order.id);
    } else if (r.status === "processing") {
      logger.info(`PayDisini reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      nudgeOutboxDispatcher();
      await editBubbleToSuccess(api, r.order);
      await clearOrderPaymentMessage(prisma, r.order.id);
    } else if (r.status === "stale") {
      logger.warn(`Order ${order.orderCode} was paid but is no longer PENDING — likely already delivered by the webhook, no action needed`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `Order ${order.orderCode} was paid (PayDisini) but delivery threw — admin alerted for manual action`);
    await alertAdmins(api, `⚠️ PayDisini paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
  }
  return "ok";
}

/** Cap on how many pending orders one reconcile cycle checks against the
 * gateway, oldest first (closest to auto-cancelling, so a large backlog
 * still gets its most time-sensitive orders checked every cycle instead of
 * one unbounded sequential sweep). Orders beyond the cap simply wait for the
 * next cycle, `POLL_INTERVAL_SECONDS` later: the storefront webhook is still
 * the PRIMARY delivery path (see the module doc-comment) — this poller only
 * fills the gap when the webhook can't reach the app, so a capped order
 * waiting one extra cycle only delays the safety net catching it, never the
 * normal delivery path. (Task 11.) */
export const MAX_ORDERS_PER_CYCLE = 50;

// cycleTimeoutMs derivation (Task 3 review follow-up shape — see
// bybitBscConfirmationTracker.ts's TRACKER_CYCLE_TIMEOUT_MS for the worked
// precedent this mirrors): one cycle makes at most MAX_ORDERS_PER_CYCLE
// sequential checkTransaction calls, each individually bounded at
// HTTP_TIMEOUT_MS.gatewayRead (10s) — so MAX_ORDERS_PER_CYCLE ×
// HTTP_TIMEOUT_MS.gatewayRead is the raw worst case (500_000ms at today's
// cap/timeout). +30s margin covers the DB list/deliver work and
// sweepDeliveredAwaitingEdit that run alongside the gateway calls each cycle.
const PER_ORDER_WORST_CASE_MS = HTTP_TIMEOUT_MS.gatewayRead;
const CYCLE_TIMEOUT_MARGIN_MS = 30_000;
/** MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS + margin = 530_000 —
 * passed to `createPollLoop` below as this rail's `cycleTimeoutMs`. */
const RECONCILE_CYCLE_TIMEOUT_MS = MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

export async function pollOnce(api: Api): Promise<void> {
  const creds = await getPaydisiniCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

  const orders = await listPendingPaydisiniOrders(prisma, new Date(), MAX_ORDERS_PER_CYCLE);
  if (!orders.length) {
    // An empty pending list is a successful cycle, not a skipped one — a
    // healthy shop that's simply quiet must still advance the heartbeat, or
    // it reads as stale after 5 minutes and the Task 12 watchdog pages
    // admins over nothing (Task 11 brief).
    await recordPollHealth(prisma, "paydisini", { lastTxCount: 0, success: true }).catch(() => undefined);
    return;
  }
  logger.info(`PayDisini reconcile checking ${orders.length} pending order(s) against the gateway`);

  let gatewayErrors = 0;
  for (const order of orders) {
    const outcome = await reconcileOrder(api, creds, order);
    if (outcome === "gateway_error") gatewayErrors++;
  }

  // A cycle counts as failed only when EVERY gateway call in it failed — one
  // flaky order is normal noise; a gateway that answered zero of N calls is
  // an outage worth surfacing.
  const allFailed = gatewayErrors === orders.length;
  await recordPollHealth(prisma, "paydisini", {
    lastTxCount: orders.length,
    success: !allFailed,
    error: allFailed
      ? `PayDisini gateway unreachable — all ${orders.length} pending order status check(s) failed this cycle`
      : null,
  }).catch(() => undefined);

  // Catches orders the storefront webhook delivered (the bubble flip never
  // happens on the web — CLAUDE.md "never send Telegram from the web").
  await sweepDeliveredAwaitingEdit(api);
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors the other
// poll modules so enabling/disabling PayDisini in Settings takes effect without a
// restart (each cycle re-checks getPaydisiniCreds).
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
  name: "PayDisini reconcile",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: RECONCILE_CYCLE_TIMEOUT_MS,
  run: () => pollOnce(boundApi!),
});

export function startPolling(api: Api): void {
  boundApi = api;
  void getPaydisiniCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("PayDisini reconcile disabled (no userkey/apikey in Settings or .env) — poller idle");
      return;
    }
    logger.info(`PayDisini reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
