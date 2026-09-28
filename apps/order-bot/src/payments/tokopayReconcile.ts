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
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { checkTransaction, qrisChargeAmount, RateLimitedError } from "@app/core/payments/tokopay";
import { gatewayLedgerTrxId } from "@app/core/payments/ledgerKey";
import {
  MAX_ORDERS_PER_CYCLE,
  RECONCILE_TELEGRAM_TIMEOUT_MS,
  TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS,
} from "@app/core/payments/reconcileCycleBudget";
import {
  prisma,
  getTokopayCreds,
  listPendingTokopayOrders,
  deliverPaidTokopayOrder,
  markOrderUnderpaid,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { flipSettledOrderBubble } from "../jobs";
import { createBackoffGate } from "./pollBackoff";
import { createPollLoop } from "./pollLoop";
import { createRotatingCursor } from "./rotatingCursor";

type PendingOrder = Awaited<ReturnType<typeof listPendingTokopayOrders>>[number];

/** What `editBubbleAndClear` needs off a settled order to hand to
 * `flipSettledOrderBubble` (jobs/index.ts) — the anchor to edit, the row it
 * clears afterwards, and everything `settledPaymentBubble` (`util/delivery.ts`)
 * reads to decide WHICH success message this order gets. No buyer read is
 * needed — `settledPaymentBubble` interpolates no balance into either branch
 * — so this carries no `userId`/`currency`/`totalAmount`. `deliverPaidTokopayOrder`
 * returns a full `getOrder` row, so every field here is already on it;
 * nothing in packages/db needed widening. */
type AnchoredOrder = {
  id: number;
  orderCode: string;
  kind: string;
  status: string;
  paymentMsgChatId: bigint | null;
  paymentMsgId: number | null;
  user: { language: string };
};

/** Race `promise` against `timeoutMs`; resolves `"timeout"` if the deadline
 * wins. The underlying grammY call isn't cancelled when this loses the race —
 * it may still complete in the background, the same accepted trade-off
 * pollLoop.ts's own cycle-abandon deadline makes for a hung `run()` — so this
 * only bounds how long the caller waits on it, not the call itself. */
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

/** Bound for the two Telegram calls reconcileOrder makes directly on the
 * payment path — the bubble flip and alertAdmins — once a gateway call
 * has already reported an order paid (Task 11 review follow-up, Critical
 * #1). main.ts no longer sets a bot-wide client timeout (that "wider lever"
 * was itself the regression it introduced — see buildBot() there), so
 * without an explicit bound here these calls fall back to grammY's 500s
 * per-call default and a single hung one could singlehandedly consume most
 * of a cycle's budget. Deliberately tighter than SWEEP_EDIT_TIMEOUT_MS (the
 * generic paid-order bubble sweeper's own per-edit budget,
 * packages/core/src/payments/reconcileCycleBudget.ts, used by
 * `sweepPaidOrderBubbles` in apps/order-bot/src/jobs/index.ts, Task T2-E):
 * both wrap the same kind of call, but this one sits inside the PRIMARY
 * per-order loop, whose worst case is multiplied by MAX_ORDERS_PER_CYCLE
 * below, while the generic sweeper runs on its own separate cron tick and no
 * longer factors into this rail's cycle-timeout math at all — this rail used
 * to run its own per-rail sweep here too, contributing a flat term to
 * RECONCILE_CYCLE_TIMEOUT_MS below, until Task T2-F replaced it with the
 * generic sweeper and removed that term. A pure-text edit/message (no media,
 * unlike a fresh checkout's QR photo) reliably finishes in well under a
 * second in the normal case, so 5s stays generous while keeping the
 * cycle-timeout arithmetic well clear of PAYMENT_WINDOW_MINUTES (see
 * RECONCILE_CYCLE_TIMEOUT_MS below).
 *
 * RECONCILE_TELEGRAM_TIMEOUT_MS itself now lives in
 * packages/core/src/payments/reconcileCycleBudget.ts (Task 13 review
 * follow-up), shared with PayDisini/NOWPayments and re-imported above, so
 * it, MAX_ORDERS_PER_CYCLE, and RECONCILE_CYCLE_TIMEOUT_MS below are all one
 * canonical value the web-admin dashboard can also read. */
export { MAX_ORDERS_PER_CYCLE, RECONCILE_TELEGRAM_TIMEOUT_MS };

/**
 * Flip this order's anchored bubble to its success message and clear the
 * anchor once that's settled for good — delegating the actual edit/classify/
 * clear-anchor sequence to the one shared body every settled-bubble flip in
 * this app now calls, `flipSettledOrderBubble` (jobs/index.ts): same
 * `settledPaymentBubble`/`bubbleOnPhotoFor` mapping (util/delivery.ts) the
 * background sweeper and the buyer's own "🔄 Refresh Status" tap use, so a
 * QRIS buyer can never be told a different story than a Binance/Bybit one for
 * the same kind of order; same `isPermanentBubbleEditFailure`
 * (util/bubbleEditFailure.ts) anchor policy; same `clearOrderPaymentMessage`
 * on any finished attempt. This wrapper only owns what's specific to this
 * rail: bounding the edit at `RECONCILE_TELEGRAM_TIMEOUT_MS` — tighter than
 * the shared body's own default, since this sits inside the reconcile loop's
 * per-order budget (see that constant's own doc comment above), and passed
 * straight through as `editTimeoutMs` rather than wrapped a second time — and
 * its own log wording for "timeout"/"kept": a timed-out or flood-controlled
 * edit leaves the anchor in place so the next cycle's fast path, or the
 * generic paid-order bubble sweep (`sweepPaidOrderBubbles`, jobs/index.ts),
 * retries it.
 */
async function editBubbleAndClear(api: Api, order: AnchoredOrder): Promise<void> {
  const outcome = await flipSettledOrderBubble(api, order, RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`TokoPay reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — the edit was not cancelled and may still land on its own; if it does not, the anchor stays put and the background bubble sweep retries it`);
    return;
  }
  if (outcome === "kept") {
    logger.warn(`TokoPay reconcile could not flip order ${order.orderCode}'s payment bubble to the success message, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`);
    return;
  }
  // "not_settled" / "no_anchor" / a finished BubbleEditResult: nothing left
  // to do — flipSettledOrderBubble already cleared the anchor itself on any
  // finished attempt.
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
    if (err instanceof RateLimitedError) {
      // Still a "gateway_error" for pollOnce's outage tally below — only the
      // backoff gate is new: it makes the next cycles skip instead of hitting
      // a throttling gateway again at the flat poll interval.
      const { hitCount, delayMs } = backoff.recordRateLimit();
      logger.warn(`TokoPay rate-limited the status check for order ${order.orderCode} (hit #${hitCount}) — backing off ${delayMs}ms before the next reconcile cycle`);
    } else {
      logger.warn({ err }, `Failed to check TokoPay status for order ${order.orderCode} — will retry on the next reconcile cycle`);
    }
    return "gateway_error";
  }
  if (!status.paid) return "ok";

  // Paid but short — never deliver on an underpayment; flag UNDERPAID and
  // alert admins instead of leaving it silently PENDING (I-5). The order's
  // own status is the idempotency guard — a second cycle re-checking an
  // already-UNDERPAID order is a no-op (markOrderUnderpaid returns false).
  if (status.amount.lessThan(expectedCharge)) {
    if (await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "TokoPay", receivedAmount: status.amount, expectedAmount: expectedCharge })) {
      logger.warn(`Order ${order.orderCode} underpaid — TokoPay reports ${status.amount}, expected ${expectedCharge}, left PENDING for manual review`);
      const alertOutcome = await withTimeout(
        alertAdmins(api, `⚠️ Underpaid order <code>${order.orderCode}</code>\nReceived <b>${status.amount.toString()}</b>, expected <b>${expectedCharge.toString()}</b> (TokoPay).`),
        RECONCILE_TELEGRAM_TIMEOUT_MS,
      );
      if (alertOutcome === "timeout") {
        logger.warn(`TokoPay reconcile gave up waiting on the underpaid-order admin alert for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — some admins may not have been notified`);
      }
    }
    return "ok";
  }

  try {
    const r = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      // The SAME ledger-key rule the storefront's TokoPay webhook applies
      // (`gatewayLedgerTrxId`, @app/core/payments/ledgerKey), so whichever of
      // the two paths sees this payment second collides on the row the first
      // one already claimed. This poller used to invent
      // `reconcile-<orderCode>` here instead, which is a different UNIQUE row
      // from anything the webhook could ever write — the ledger, the primary
      // idempotency gate, then missed the duplicate entirely and left it to
      // the order-status check one layer down.
      trxId: gatewayLedgerTrxId(status.trxId, order.orderCode),
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`TokoPay reconcile delivered order ${order.orderCode} — flipping its payment bubble, then nudging the notifier to DM the account file immediately`);
      // Flip BEFORE nudging (Task E3): the buyer's chat must show "Payment
      // received" before their account file arrives, not after — the outbox
      // dispatcher's own payment-bubble flush hook (packages/core/src/nudge.ts)
      // is the structural backstop if this still loses the race (e.g. a slow
      // Telegram edit), but the ordering here should teach the right lesson
      // regardless.
      await editBubbleAndClear(api, r.order);
      nudgeOutboxDispatcher();
    } else if (r.status === "processing") {
      logger.info(`TokoPay reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      await editBubbleAndClear(api, r.order);
      nudgeOutboxDispatcher();
    } else if (r.status === "stale") {
      logger.warn(`Order ${order.orderCode} was paid but is no longer PENDING — likely already delivered by the webhook, no action needed`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `Order ${order.orderCode} was paid (TokoPay) but delivery threw — admin alerted for manual action`);
    const alertOutcome = await withTimeout(
      alertAdmins(api, `⚠️ TokoPay paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`),
      RECONCILE_TELEGRAM_TIMEOUT_MS,
    );
    if (alertOutcome === "timeout") {
      logger.warn(`TokoPay reconcile gave up waiting on the admin alert for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — some admins may not have been notified`);
    }
  }
  return "ok";
}

// MAX_ORDERS_PER_CYCLE (cap on pending orders checked per cycle, oldest
// first — the storefront webhook stays the PRIMARY delivery path, this
// poller only fills the gap when it can't reach the app, Task 11) and
// RECONCILE_CYCLE_TIMEOUT_MS (this rail's cycleTimeoutMs, passed to
// createPollLoop below) both now live in
// packages/core/src/payments/reconcileCycleBudget.ts as
// TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS (Task 13 review follow-up) — see that
// module for the full derivation, including the PAYMENT_WINDOW_MINUTES
// sanity check (enforced as a test in poll-loop-wiring.test.ts). Re-exported
// under this file's original name so existing imports (the wiring test,
// jobs/index.ts) keep working unchanged.
export const RECONCILE_CYCLE_TIMEOUT_MS = TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS;

// MAX_ORDERS_PER_CYCLE caps how many of the pending backlog one cycle checks
// against the gateway — listPendingTokopayOrders orders oldest-first, so
// without rotation a backlog over the cap would starve orders 51+ until
// enough older ones expire out (followup-review-fixes-2). `cursor` rotates
// WHICH slice of that oldest-first list gets checked each cycle instead —
// same fix bybitBscConfirmationTracker.ts already applies to its own capped
// scan, reused here via rotatingCursor.ts rather than re-implemented.
const cursor = createRotatingCursor();

// Bounded exponential backoff on gateway HTTP 429s (pollBackoff.ts, base 3s
// doubling to a 30s cap) — the same gate binanceInternal.ts and the Bybit
// rails use. Armed by reconcileOrder's catch on a RateLimitedError, checked at
// the top of pollOnce (a skipped cycle writes no heartbeat, exactly like
// binanceInternal.ts), and cleared only by a cycle in which the gateway
// answered at least one call and threw no rate-limit at all.
const backoff = createBackoffGate();

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const creds = await getTokopayCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too
  if (backoff.shouldSkip()) return;

  const allPending = await listPendingTokopayOrders(prisma, new Date());
  if (!allPending.length) {
    // An empty pending list is a successful cycle, not a skipped one — a
    // healthy shop that's simply quiet must still advance the heartbeat, or
    // it reads as stale after 5 minutes and the Task 12 watchdog pages
    // admins over nothing (Task 11 brief).
    //
    // Task 11 review follow-up, Important #1 (Finding A): guarded by
    // isCurrent() — a cycle abandoned by pollLoop.ts's deadline keeps
    // running in the background and can still reach this write minutes
    // later, overwriting the abandon-failure heartbeat with a retroactive
    // success and resetting consecutiveFailures. Skipped instead once
    // isCurrent() is false.
    if (isCurrent()) {
      await recordPollHealth(prisma, "tokopay", { lastTxCount: 0, success: true }).catch(() => undefined);
    } else {
      logger.warn("TokoPay reconcile cycle finished after its own deadline had already abandoned it — skipping the success heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
    }
    return;
  }

  const orders = cursor.next(allPending, MAX_ORDERS_PER_CYCLE);
  logger.info(
    orders.length < allPending.length
      ? `TokoPay reconcile checking ${orders.length} of ${allPending.length} pending order(s) against the gateway (rotating window — the rest are covered over the next few cycles)`
      : `TokoPay reconcile checking ${orders.length} pending order(s) against the gateway`,
  );

  let gatewayCalls = 0;
  let gatewayErrors = 0;
  // recordRateLimit() only ever increments hitCount and nothing inside this
  // loop resets it, so an unchanged count after the loop means no call in
  // this cycle was rate-limited.
  const rateLimitHitsBefore = backoff.hitCount;
  for (const order of orders) {
    const outcome = await reconcileOrder(api, creds, order);
    if (outcome === "skipped") continue; // no gateway call made — not evidence either way
    gatewayCalls++;
    if (outcome === "gateway_error") gatewayErrors++;
  }
  cursor.advance(orders.length);
  // Cleared once per cycle, after the loop — never per order, so a rate-limit
  // earlier in this batch can't be wiped by a later order that got through.
  if (gatewayErrors < gatewayCalls && backoff.hitCount === rateLimitHitsBefore) backoff.recordSuccess();

  // A cycle counts as failed only when EVERY gateway call in it failed — one
  // flaky order is normal noise; a gateway that answered zero of N calls is
  // an outage worth surfacing. Denominator is gatewayCalls, not orders.length
  // (Task 11 review follow-up, Critical #1 — this rail's reconcileOrder never
  // actually skips today, but the shape is shared with nowpaymentsReconcile.ts,
  // where it does, so both stay correct even if this rail ever grows a skip
  // path). `gatewayCalls > 0` keeps an all-skipped cycle correctly successful.
  //
  // The whole write below is guarded by isCurrent() (Task 11 review
  // follow-up, Important #1 / Finding A) rather than only its `success: true`
  // case: a stale write from an abandoned cycle is stale evidence either way
  // — even a `success: false` write here would double-count the SAME
  // underlying failure the abandon heartbeat already recorded (once as the
  // abandon, once here) — so the simplest correct rule is "the abandoned
  // cycle's own view of this cycle's outcome is retired the moment it's
  // abandoned", not just its optimistic half.
  const allFailed = gatewayCalls > 0 && gatewayErrors === gatewayCalls;
  if (isCurrent()) {
    await recordPollHealth(prisma, "tokopay", {
      lastTxCount: orders.length,
      success: !allFailed,
      error: allFailed
        ? `TokoPay gateway unreachable — all ${gatewayCalls} pending order status check(s) failed this cycle`
        : null,
    }).catch(() => undefined);
  } else {
    logger.warn("TokoPay reconcile cycle finished after its own deadline had already abandoned it — skipping the heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
  }
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
// own worst case for the reconcile loop (see
// packages/core/src/payments/reconcileCycleBudget.ts's derivation comment —
// 780s; it no longer carries a per-rail bubble-sweep term now that the
// generic sweepPaidOrderBubbles, apps/order-bot/src/jobs/index.ts, Task
// T2-E, replaced this rail's own per-rail sweep). Without this the default
// `max(3 * intervalMs, 60_000)` (60s at the default POLL_INTERVAL_SECONDS)
// would abandon a cycle mid-batch long before a full MAX_ORDERS_PER_CYCLE
// pass of a slow-but-not-hung gateway could finish.
//
// `onCycleTimeout` writes the same shape of failed heartbeat the normal-path
// error branch above does (Task 11 review follow-up, Important #3): without
// it, an abandoned cycle recorded NOTHING, so a hung TokoPay poller was
// indistinguishable from a healthy-but-quiet one until Task 12's watchdog
// (not yet landed) started comparing `lastRun` against the interval. Unlike
// binanceInternal.ts's abandon heartbeat, this rail's heartbeats do not carry
// its backoff gate's state (the gate above only decides whether a cycle runs;
// none of this file's heartbeat writes report it), so the payload is just the
// bare failure shape — `lastTxCount: 0` (never the success branch's `orders.length`; the
// cycle was abandoned mid-flight, so how many orders it actually finished
// checking is unknown).
const loop = createPollLoop({
  name: "TokoPay reconcile",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: RECONCILE_CYCLE_TIMEOUT_MS,
  run: (isCurrent) => pollOnce(boundApi!, isCurrent),
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
  }).catch((err) =>
    // Mandatory, not defensive tidiness: nothing awaits this promise, so
    // without a handler a failed settings read here (a locked SQLite file
    // during a busy boot is the realistic one) becomes an unhandled rejection,
    // and Node's default since v15 is to crash the process — losing all six
    // pollers over one cosmetic log line.
    logger.warn({ err }, "Could not read the TokoPay credentials for the startup log, so this boot has no line saying whether the TokoPay reconcile poller is on or idle — the poller itself is unaffected, since it re-reads the credentials at the top of every cycle"),
  );
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
