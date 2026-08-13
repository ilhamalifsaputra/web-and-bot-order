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
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { t as coreT } from "@app/core/i18n";
import { HTTP_TIMEOUT_MS } from "@app/core/http";
import { checkTransaction, qrisChargeAmount } from "@app/core/payments/tokopay";
import {
  prisma,
  getTokopayCreds,
  listPendingTokopayOrders,
  deliverPaidTokopayOrder,
  listDeliveredOrdersAwaitingEdit,
  clearOrderPaymentMessage,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { paymentSuccessKb } from "../keyboards/customer";
import { createPollLoop } from "./pollLoop";

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

/** Per-order budget for waiting on a sweep bubble edit (Task 11 review
 * follow-up, Important #2). grammY's Api client has no built-in per-call
 * timeout the way this codebase's own gateway fetch clients do (see
 * @app/core/http), so an unbounded sweep loop could hang on a single
 * black-holed `editMessageCaption`/`editMessageText` call forever — the most
 * plausible remaining way a reconcile cycle hangs, now that every gateway
 * call is itself bounded at HTTP_TIMEOUT_MS.gatewayRead. 10s mirrors that
 * same budget for consistency. */
const SWEEP_EDIT_TIMEOUT_MS = 10_000;

/** Race `promise` against `timeoutMs`; resolves `"timeout"` if the deadline
 * wins. The underlying grammY call isn't cancelled when this loses the race —
 * it may still complete in the background, the same accepted trade-off
 * pollLoop.ts's own cycle-abandon deadline makes for a hung `run()` — so this
 * only bounds how long the SWEEP waits on it, not the call itself. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Sweep DELIVERED TokoPay orders whose bubble hasn't been flipped yet (catches
 * webhook deliveries). Idempotent: clears the anchor after editing so a re-run
 * is a no-op. Bounded two ways (Task 11 review follow-up, Important #2): the
 * list itself is capped at MAX_ORDERS_PER_CYCLE, and each order's edit gets at
 * most SWEEP_EDIT_TIMEOUT_MS before the sweep gives up on it and moves on —
 * without both, this loop was uncapped and its grammY calls unbounded, so the
 * 530s `cycleTimeoutMs` (sized only off the 50 gateway calls) didn't actually
 * bound the whole cycle. A timed-out edit leaves the anchor in place so the
 * next cycle retries it — clearing only happens once an edit genuinely
 * completes (not necessarily succeeds; editBubbleToSuccess never throws).
 */
export async function sweepDeliveredAwaitingEdit(api: Api): Promise<void> {
  const orders = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.TOKOPAY, MAX_ORDERS_PER_CYCLE);
  for (const order of orders) {
    const outcome = await withTimeout(editBubbleToSuccess(api, order), SWEEP_EDIT_TIMEOUT_MS);
    if (outcome === "timeout") {
      logger.warn(`TokoPay sweep gave up waiting on the bubble edit for order ${order.orderCode} after ${SWEEP_EDIT_TIMEOUT_MS}ms — anchor left in place so the next cycle retries`);
      continue;
    }
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
 * Returns `"skipped"` when no gateway call was made at all (defensive —
 * `pollOnce` never calls this without creds already resolved, but this keeps
 * the same three-way shape as nowpaymentsReconcile.ts's `reconcileOrder`, the
 * one rail that DOES have a real skip path, so the two can't drift back apart
 * (Task 11 review follow-up, Critical #1)).
 */
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getTokopayCreds>>, order: PendingOrder): Promise<"ok" | "skipped" | "gateway_error"> {
  if (!creds) return "skipped";
  const expectedCharge = qrisChargeAmount(order.totalAmount);
  let status: Awaited<ReturnType<typeof checkTransaction>>;
  try {
    status = await checkTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
  } catch (err) {
    logger.warn({ err }, `Failed to check TokoPay status for order ${order.orderCode} — will retry on the next reconcile cycle`);
    return "gateway_error";
  }
  if (!status.paid) return "ok";

  // Paid but short — never deliver on an underpayment; leave for manual review.
  if (status.amount.lessThan(expectedCharge)) {
    logger.warn(`Order ${order.orderCode} underpaid — TokoPay reports ${status.amount}, expected ${expectedCharge}, left PENDING for manual review`);
    return "ok";
  }

  try {
    const r = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: status.trxId ?? `reconcile-${order.orderCode}`,
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`TokoPay reconcile delivered order ${order.orderCode} — nudging notifier to DM the account file immediately`);
      nudgeOutboxDispatcher();
      await editBubbleToSuccess(api, r.order);
      await clearOrderPaymentMessage(prisma, r.order.id);
    } else if (r.status === "processing") {
      logger.info(`TokoPay reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      nudgeOutboxDispatcher();
      await editBubbleToSuccess(api, r.order);
      await clearOrderPaymentMessage(prisma, r.order.id);
    } else if (r.status === "stale") {
      logger.warn(`Order ${order.orderCode} was paid but is no longer PENDING — likely already delivered by the webhook, no action needed`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `Order ${order.orderCode} was paid (TokoPay) but delivery threw — admin alerted for manual action`);
    await alertAdmins(api, `⚠️ TokoPay paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`);
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
// HTTP_TIMEOUT_MS.gatewayRead is the raw worst case for the reconcile loop
// (500_000ms at today's cap/timeout). sweepDeliveredAwaitingEdit runs
// alongside it and used to be unaccounted-for margin — Task 11 review
// follow-up, Important #2 found it was actually uncapped/untimed, so the
// derivation now folds in its OWN worst case the same way: at most
// MAX_ORDERS_PER_CYCLE edits (the sweep's own `limit`), each bounded at
// SWEEP_EDIT_TIMEOUT_MS (another 500_000ms). +30s margin covers the
// remaining DB list/deliver work around both loops.
const PER_ORDER_WORST_CASE_MS = HTTP_TIMEOUT_MS.gatewayRead;
const CYCLE_TIMEOUT_MARGIN_MS = 30_000;
/** MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS (reconcile) +
 * MAX_ORDERS_PER_CYCLE × SWEEP_EDIT_TIMEOUT_MS (sweep) + margin = 1_030_000 —
 * passed to `createPollLoop` below as this rail's `cycleTimeoutMs`. Exported
 * (Task 11 review follow-up, Minor #5) so the wiring test imports the real
 * value instead of a hardcoded copy that could silently drift from it. */
export const RECONCILE_CYCLE_TIMEOUT_MS =
  MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + MAX_ORDERS_PER_CYCLE * SWEEP_EDIT_TIMEOUT_MS + CYCLE_TIMEOUT_MARGIN_MS;

export async function pollOnce(api: Api): Promise<void> {
  const creds = await getTokopayCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

  const orders = await listPendingTokopayOrders(prisma, new Date(), MAX_ORDERS_PER_CYCLE);
  if (!orders.length) {
    // An empty pending list is a successful cycle, not a skipped one — a
    // healthy shop that's simply quiet must still advance the heartbeat, or
    // it reads as stale after 5 minutes and the Task 12 watchdog pages
    // admins over nothing (Task 11 brief).
    await recordPollHealth(prisma, "tokopay", { lastTxCount: 0, success: true }).catch(() => undefined);
    return;
  }
  logger.info(`TokoPay reconcile checking ${orders.length} pending order(s) against the gateway`);

  let gatewayCalls = 0;
  let gatewayErrors = 0;
  for (const order of orders) {
    const outcome = await reconcileOrder(api, creds, order);
    if (outcome === "skipped") continue; // no gateway call made — not evidence either way
    gatewayCalls++;
    if (outcome === "gateway_error") gatewayErrors++;
  }

  // A cycle counts as failed only when EVERY gateway call in it failed — one
  // flaky order is normal noise; a gateway that answered zero of N calls is
  // an outage worth surfacing. Denominator is gatewayCalls, not orders.length
  // (Task 11 review follow-up, Critical #1 — this rail's reconcileOrder never
  // actually skips today, but the shape is shared with nowpaymentsReconcile.ts,
  // where it does, so both stay correct even if this rail ever grows a skip
  // path). `gatewayCalls > 0` keeps an all-skipped cycle correctly successful.
  const allFailed = gatewayCalls > 0 && gatewayErrors === gatewayCalls;
  await recordPollHealth(prisma, "tokopay", {
    lastTxCount: orders.length,
    success: !allFailed,
    error: allFailed
      ? `TokoPay gateway unreachable — all ${gatewayCalls} pending order status check(s) failed this cycle`
      : null,
  }).catch(() => undefined);

  // Catches orders the storefront webhook delivered (the bubble flip never
  // happens on the web — CLAUDE.md "never send Telegram from the web").
  await sweepDeliveredAwaitingEdit(api);
}

// ---------------------------------------------------------------------------
// Self-scheduling loop (guards against overlapping runs) — mirrors the other
// poll modules so enabling/disabling TokoPay in Settings takes effect without a
// restart (each cycle re-checks getTokopayCreds).
// ---------------------------------------------------------------------------

// Set by startPolling() before the loop's `run` ever fires — the loop
// itself starts `stopped`, so `run` can never be invoked while this is
// still undefined.
let boundApi: Api | undefined;

// cycleTimeoutMs is RECONCILE_CYCLE_TIMEOUT_MS, sized off MAX_ORDERS_PER_CYCLE's
// own worst case for BOTH the reconcile loop and the sweep (see the
// derivation comment above pollOnce) — 1_030s. Without this the default
// `max(3 * intervalMs, 60_000)` (60s at the default POLL_INTERVAL_SECONDS)
// would abandon a cycle mid-batch long before a full MAX_ORDERS_PER_CYCLE
// sweep of a slow-but-not-hung gateway could finish.
//
// `onCycleTimeout` writes the same shape of failed heartbeat the normal-path
// error branch above does (Task 11 review follow-up, Important #3): without
// it, an abandoned cycle recorded NOTHING, so a hung TokoPay poller was
// indistinguishable from a healthy-but-quiet one until Task 12's watchdog
// (not yet landed) started comparing `lastRun` against the interval. Unlike
// binanceInternal.ts's abandon heartbeat, this rail has no backoff gate or
// rate-limit counter to preserve, so the payload is just the bare failure
// shape — `lastTxCount: 0` (never the success branch's `orders.length`; the
// cycle was abandoned mid-flight, so how many orders it actually finished
// checking is unknown).
const loop = createPollLoop({
  name: "TokoPay reconcile",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: RECONCILE_CYCLE_TIMEOUT_MS,
  run: () => pollOnce(boundApi!),
  onCycleTimeout: (elapsedMs) =>
    recordPollHealth(prisma, "tokopay", {
      lastTxCount: 0,
      success: false,
      error: `Poll cycle abandoned after ${elapsedMs}ms without finishing`,
    }).catch(() => undefined),
});

export function startPolling(api: Api): void {
  boundApi = api;
  void getTokopayCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("TokoPay reconcile disabled (no merchant/secret in Settings or .env) — poller idle");
      return;
    }
    logger.info(`TokoPay reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  });
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
