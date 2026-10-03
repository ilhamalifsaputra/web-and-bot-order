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
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { Decimal } from "@app/core/money";
import { checkTransaction, RateLimitedError } from "@app/core/payments/paydisini";
import { gatewayLedgerTrxId } from "@app/core/payments/ledgerKey";
import {
  MAX_ORDERS_PER_CYCLE,
  RECONCILE_TELEGRAM_TIMEOUT_MS,
  PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS,
} from "@app/core/payments/reconcileCycleBudget";
import {
  prisma,
  getPaydisiniCreds,
  listPendingPaydisiniOrders,
  deliverPaidPaydisiniOrder,
  markOrderUnderpaid,
  recordPollHealth,
  recordUnmatchedPaydisiniTx,
  enqueueAdminStalePayment,
} from "@app/db";
import { esc } from "../util/format";
import { flipSettledOrderBubble } from "../jobs";
import { createBackoffGate } from "./pollBackoff";
import { createPollLoop } from "./pollLoop";
import { createRotatingCursor } from "./rotatingCursor";

type PendingOrder = Awaited<ReturnType<typeof listPendingPaydisiniOrders>>[number];

/** Twin of tokopayReconcile.ts's own `AnchoredOrder` — what `editBubbleAndClear`
 * needs off a settled order to hand to `flipSettledOrderBubble`
 * (jobs/index.ts): the anchor to edit, the row cleared afterwards, and
 * everything `settledPaymentBubble` (`util/delivery.ts`) reads to decide
 * WHICH success message this order gets. No buyer read is needed —
 * `settledPaymentBubble` interpolates no balance into either branch — so
 * this carries no `userId`/`currency`/`totalAmount`. `deliverPaidPaydisiniOrder`
 * returns a full `getOrder` row, so every field here is already on it. */
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
 * follow-up), shared with TokoPay/NOWPayments and re-imported above, so it,
 * MAX_ORDERS_PER_CYCLE, and RECONCILE_CYCLE_TIMEOUT_MS below are all one
 * canonical value the web-admin dashboard can also read. */
export { MAX_ORDERS_PER_CYCLE, RECONCILE_TELEGRAM_TIMEOUT_MS };

/**
 * Flip this order's anchored bubble to its success message and clear the
 * anchor once that's settled for good — delegating the actual edit/classify/
 * clear-anchor sequence to the one shared body every settled-bubble flip in
 * this app now calls, `flipSettledOrderBubble` (jobs/index.ts): same
 * composition step, and the same reasons for it, as the TokoPay twin in
 * tokopayReconcile.ts — `settledPaymentBubble`/`bubbleOnPhotoFor`
 * (util/delivery.ts) is the one mapping that decides a settled order's ending
 * for every rail, and `isPermanentBubbleEditFailure`
 * (util/bubbleEditFailure.ts) the one anchor policy. This wrapper only owns
 * what's specific to this rail: bounding the edit at
 * `RECONCILE_TELEGRAM_TIMEOUT_MS` (tighter than the shared body's own
 * default, since this sits inside the reconcile loop's per-order budget —
 * see that constant's own doc comment above) and its own log wording for
 * "timeout"/"kept" — a timed-out or flood-controlled edit leaves the anchor
 * in place so the next cycle's fast path, or the generic paid-order bubble
 * sweep (`sweepPaidOrderBubbles`, jobs/index.ts), retries it.
 */
async function editBubbleAndClear(api: Api, order: AnchoredOrder): Promise<void> {
  const outcome = await flipSettledOrderBubble(api, order, RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`PayDisini reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — the edit was not cancelled and may still land on its own; if it does not, the anchor stays put and the background bubble sweep retries it`);
    return;
  }
  if (outcome === "kept") {
    logger.warn(`PayDisini reconcile could not flip order ${order.orderCode}'s payment bubble to the success message, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`);
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
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getPaydisiniCreds>>, order: PendingOrder): Promise<"ok" | "skipped" | "gateway_error"> {
  if (!creds) return "skipped";
  let status: Awaited<ReturnType<typeof checkTransaction>>;
  try {
    status = await checkTransaction(creds, { refId: order.orderCode, amountIdr: order.totalAmount });
  } catch (err) {
    if (err instanceof RateLimitedError) {
      // Still a "gateway_error" for pollOnce's outage tally below — only the
      // backoff gate is new: it makes the next cycles skip instead of hitting
      // a throttling gateway again at the flat poll interval.
      const { hitCount, delayMs } = backoff.recordRateLimit();
      logger.warn(`PayDisini rate-limited the status check for order ${order.orderCode} (hit #${hitCount}) — backing off ${delayMs}ms before the next reconcile cycle`);
    } else {
      logger.warn({ err }, `Failed to check PayDisini status for order ${order.orderCode} — will retry on the next reconcile cycle`);
    }
    return "gateway_error";
  }
  if (status.unverified) {
    // PayDisini says PAID but its status carried no amount (Task B fix round). Never
    // deliver on it, but money may have arrived, so park it in the unmatched
    // manual-review queue and alert the admins once — the UNIQUE ledger key
    // (shared with the webhook) dedupes every later cycle. The row stays
    // reclaimable, so a later status that does carry the amount still delivers.
    const trxId = gatewayLedgerTrxId(status.trxId, order.orderCode);
    if (await recordUnmatchedPaydisiniTx(prisma, { trxId, amount: 0 })) {
      await enqueueAdminStalePayment(prisma, {
        orderId: order.id,
        orderCode: order.orderCode,
        gateway: "PayDisini",
        trxId,
        reason: "unverified_amount",
      });
      logger.warn(`PayDisini reports order ${order.orderCode} as paid but without an amount, so the payment could not be verified — nothing was delivered; it is parked in the unmatched queue and the admins were alerted to check it in the PayDisini dashboard`);
      nudgeOutboxDispatcher();
    }
    return "ok";
  }
  if (!status.paid) return "ok";

  // Paid but short — never deliver on an underpayment; flag UNDERPAID and
  // alert admins instead of leaving it silently PENDING (I-5). The order's
  // own status is the idempotency guard — a second cycle re-checking an
  // already-UNDERPAID order is a no-op (markOrderUnderpaid returns false).
  if (status.amount.lessThan(new Decimal(order.totalAmount))) {
    if (await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "PayDisini", receivedAmount: status.amount, expectedAmount: order.totalAmount })) {
      logger.warn(`Order ${order.orderCode} underpaid — PayDisini reports ${status.amount}, expected ${order.totalAmount}, left PENDING for manual review`);
      const alertOutcome = await withTimeout(
        alertAdmins(api, `⚠️ Underpaid order <code>${order.orderCode}</code>\nReceived <b>${status.amount.toString()}</b>, expected <b>${new Decimal(order.totalAmount).toString()}</b> (PayDisini).`),
        RECONCILE_TELEGRAM_TIMEOUT_MS,
      );
      if (alertOutcome === "timeout") {
        logger.warn(`PayDisini reconcile gave up waiting on the underpaid-order admin alert for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — some admins may not have been notified`);
      }
    }
    return "ok";
  }

  try {
    const r = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      // The SAME ledger-key rule the storefront's PayDisini webhook applies
      // (`gatewayLedgerTrxId`, @app/core/payments/ledgerKey) — see the
      // identical note in tokopayReconcile.ts and that helper's own doc
      // comment for why inventing `reconcile-<orderCode>` here defeated the
      // ledger's UNIQUE idempotency gate.
      trxId: gatewayLedgerTrxId(status.trxId, order.orderCode),
      amount: status.amount,
      shopUrl: null,
    });
    if (r.status === "delivered") {
      logger.info(`PayDisini reconcile delivered order ${order.orderCode} — flipping its payment bubble, then nudging the notifier to DM the account file immediately`);
      // Flip BEFORE nudging (Task E3): the buyer's chat must show "Payment
      // received" before their account file arrives, not after — the outbox
      // dispatcher's own payment-bubble flush hook (packages/core/src/nudge.ts)
      // is the structural backstop if this still loses the race (e.g. a slow
      // Telegram edit), but the ordering here should teach the right lesson
      // regardless.
      await editBubbleAndClear(api, r.order);
      nudgeOutboxDispatcher();
    } else if (r.status === "processing") {
      logger.info(`PayDisini reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      await editBubbleAndClear(api, r.order);
      nudgeOutboxDispatcher();
    } else if (r.status === "stale") {
      logger.warn(`Order ${order.orderCode} was paid but is no longer PENDING — likely already delivered by the webhook, no action needed`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `Order ${order.orderCode} was paid (PayDisini) but delivery threw — admin alerted for manual action`);
    const alertOutcome = await withTimeout(
      alertAdmins(api, `⚠️ PayDisini paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`),
      RECONCILE_TELEGRAM_TIMEOUT_MS,
    );
    if (alertOutcome === "timeout") {
      logger.warn(`PayDisini reconcile gave up waiting on the admin alert for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — some admins may not have been notified`);
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
// PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS (Task 13 review follow-up) — see that
// module for the full derivation, including the PAYMENT_WINDOW_MINUTES
// sanity check (enforced as a test in poll-loop-wiring.test.ts). Re-exported
// under this file's original name so existing imports (the wiring test,
// jobs/index.ts) keep working unchanged.
export const RECONCILE_CYCLE_TIMEOUT_MS = PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS;

// MAX_ORDERS_PER_CYCLE caps how many of the pending backlog one cycle checks
// against the gateway — listPendingPaydisiniOrders orders oldest-first, so
// without rotation a backlog over the cap would starve orders 51+ until
// enough older ones expire out (followup-review-fixes-2). `cursor` rotates
// WHICH slice of that oldest-first list gets checked each cycle instead —
// same fix bybitBscConfirmationTracker.ts already applies to its own capped
// scan, reused here via rotatingCursor.ts rather than re-implemented.
const cursor = createRotatingCursor();

// Bounded exponential backoff on gateway HTTP 429s — identical wiring to
// tokopayReconcile.ts's own gate (see the comment there).
const backoff = createBackoffGate({ baseMs: config.POLL_INTERVAL_SECONDS * 1000 });

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const creds = await getPaydisiniCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too
  if (backoff.shouldSkip()) return;

  const allPending = await listPendingPaydisiniOrders(prisma, new Date());
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
      await recordPollHealth(prisma, "paydisini", { lastTxCount: 0, success: true }).catch(() => undefined);
    } else {
      logger.warn("PayDisini reconcile cycle finished after its own deadline had already abandoned it — skipping the success heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
    }
    return;
  }

  const orders = cursor.next(allPending, MAX_ORDERS_PER_CYCLE);
  logger.info(
    orders.length < allPending.length
      ? `PayDisini reconcile checking ${orders.length} of ${allPending.length} pending order(s) against the gateway (rotating window — the rest are covered over the next few cycles)`
      : `PayDisini reconcile checking ${orders.length} pending order(s) against the gateway`,
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
    await recordPollHealth(prisma, "paydisini", {
      lastTxCount: orders.length,
      success: !allFailed,
      error: allFailed
        ? `PayDisini gateway unreachable — all ${gatewayCalls} pending order status check(s) failed this cycle`
        : null,
    }).catch(() => undefined);
  } else {
    logger.warn("PayDisini reconcile cycle finished after its own deadline had already abandoned it — skipping the heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
  }
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
// it, an abandoned cycle recorded NOTHING, so a hung PayDisini poller was
// indistinguishable from a healthy-but-quiet one until Task 12's watchdog
// (not yet landed) started comparing `lastRun` against the interval. Unlike
// binanceInternal.ts's abandon heartbeat, this rail's heartbeats do not carry
// its backoff gate's state (the gate above only decides whether a cycle runs;
// none of this file's heartbeat writes report it), so the payload is just the
// bare failure shape — `lastTxCount: 0` (never the success branch's `orders.length`; the
// cycle was abandoned mid-flight, so how many orders it actually finished
// checking is unknown).
const loop = createPollLoop({
  name: "PayDisini reconcile",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: RECONCILE_CYCLE_TIMEOUT_MS,
  run: (isCurrent) => pollOnce(boundApi!, isCurrent),
  onCycleTimeout: (elapsedMs) =>
    recordPollHealth(prisma, "paydisini", {
      lastTxCount: 0,
      success: false,
      error: `Poll cycle abandoned after ${elapsedMs}ms without finishing`,
    }).catch(() => undefined),
});

export function startPolling(api: Api): void {
  boundApi = api;
  void getPaydisiniCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("PayDisini reconcile disabled (no userkey/apikey in Settings or .env) — poller idle");
      return;
    }
    logger.info(`PayDisini reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  }).catch((err) =>
    // Mandatory, not defensive tidiness — see the identical guard in
    // tokopayReconcile.ts's startPolling for why an unhandled rejection here
    // would take the whole bot process down at boot.
    logger.warn({ err }, "Could not read the PayDisini credentials for the startup log, so this boot has no line saying whether the PayDisini reconcile poller is on or idle — the poller itself is unaffected, since it re-reads the credentials at the top of every cycle"),
  );
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
