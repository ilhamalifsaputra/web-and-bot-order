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
import { getPaymentStatus } from "@app/core/payments/nowpayments";
import {
  MAX_ORDERS_PER_CYCLE,
  RECONCILE_TELEGRAM_TIMEOUT_MS,
  NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS,
} from "@app/core/payments/reconcileCycleBudget";
import {
  prisma,
  getNowpaymentsCreds,
  listPendingNowpaymentsOrders,
  deliverPaidNowpaymentsOrder,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { flipSettledOrderBubble } from "../jobs";
import { createPollLoop } from "./pollLoop";
import { createRotatingCursor } from "./rotatingCursor";

type PendingOrder = Awaited<ReturnType<typeof listPendingNowpaymentsOrders>>[number];

/** Twin of tokopayReconcile.ts/paydisiniReconcile.ts's own `AnchoredOrder` —
 * what `editBubbleAndClear` needs off a settled order to hand to
 * `flipSettledOrderBubble` (jobs/index.ts): the anchor to edit, the row
 * cleared afterwards, and everything `settledPaymentBubble`
 * (`util/delivery.ts`) reads to decide WHICH success message this order
 * gets. No buyer read is needed — `settledPaymentBubble` interpolates no
 * balance into either branch — so this carries no
 * `userId`/`currency`/`totalAmount`. `deliverPaidNowpaymentsOrder` returns a
 * full `getOrder` row, so every field here is already on it. */
type AnchoredOrder = {
  id: number;
  orderCode: string;
  kind: string;
  status: string;
  paymentMsgChatId: bigint | null;
  paymentMsgId: number | null;
  user: { language: string };
};

// RECONCILE_TELEGRAM_TIMEOUT_MS (wait-at-most for a Telegram call on the
// reconcile path — grammY's own client default is 500s, longer than this
// rail's whole cycle budget, so without this bound a single hung admin
// alert could eat nearly the entire cycle) now lives in
// packages/core/src/payments/reconcileCycleBudget.ts (Task 13 review
// follow-up), shared with TokoPay/PayDisini's identical constant.
export { MAX_ORDERS_PER_CYCLE, RECONCILE_TELEGRAM_TIMEOUT_MS };

/** Race `promise` against `timeoutMs`; resolves `"timeout"` if the deadline
 * wins. The underlying grammY call isn't cancelled when this loses the race —
 * it may still complete in the background, the same accepted trade-off
 * pollLoop.ts's own cycle-abandon deadline makes for a hung `run()` — so this
 * only bounds how long the CYCLE waits on it, not the call itself. */
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
 * Flip this order's anchored bubble to its success message and clear the
 * anchor once that's settled for good — the bubble flip this rail never had
 * (Task E3): unlike TokoPay/PayDisini, this rail's `reconcileOrder` used to
 * never call anything like this at all, leaving a delivered order's bubble
 * stale until the generic paid-order bubble sweep's next cron tick (up to
 * ~60s later, `sweepPaidOrderBubbles`, jobs/index.ts). Delegates the actual
 * edit/classify/clear-anchor sequence to the one shared body every
 * settled-bubble flip in this app now calls, `flipSettledOrderBubble`
 * (jobs/index.ts) — identical shape and reasoning to the TokoPay/PayDisini
 * twins in tokopayReconcile.ts/paydisiniReconcile.ts: same
 * `settledPaymentBubble`/`bubbleOnPhotoFor` mapping (util/delivery.ts), same
 * `isPermanentBubbleEditFailure` (util/bubbleEditFailure.ts) anchor policy.
 * This wrapper only owns what's specific to this rail: bounding the edit at
 * `RECONCILE_TELEGRAM_TIMEOUT_MS` (see that constant's own doc comment,
 * reconcileCycleBudget.ts, for why the cycle-timeout arithmetic already
 * accounted for exactly this call before this rail ever made it) and its own
 * log wording for "timeout"/"kept".
 */
async function editBubbleAndClear(api: Api, order: AnchoredOrder): Promise<void> {
  const outcome = await flipSettledOrderBubble(api, order, RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`NOWPayments reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — anchor left in place so the next sweep retries`);
    return;
  }
  if (outcome === "kept") {
    logger.warn(`NOWPayments reconcile could not flip order ${order.orderCode}'s payment bubble to the success message, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`);
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
 * failed (network/HTTP/parse) — every other outcome, including a
 * delivery-side throw, is `"ok"`: not evidence the gateway is unreachable.
 * Returns `"skipped"` when NO gateway call was made at all — no invoice
 * created yet (paymentRef still null/unparseable) — which is neither ok nor
 * an error; `pollOnce` must exclude it from both the numerator and
 * denominator of its outage check, or a batch of invoice-less orders can
 * dilute a genuine all-calls-failed outage into a false "healthy" (Task 11
 * review follow-up, Critical #1).
 */
export async function reconcileOrder(api: Api, creds: Awaited<ReturnType<typeof getNowpaymentsCreds>>, order: PendingOrder): Promise<"ok" | "skipped" | "gateway_error"> {
  if (!creds) return "skipped";

  const invoiceId = extractInvoiceId(order.paymentRef);
  if (!invoiceId) return "skipped"; // no hosted invoice yet — nothing to reconcile, no gateway call made

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
      logger.info(`NOWPayments reconcile delivered order ${order.orderCode} — flipping its payment bubble, then nudging the notifier to DM the account file immediately`);
      // Flip BEFORE nudging (Task E3): the buyer's chat must show "Payment
      // received" before their account file arrives, not after — the outbox
      // dispatcher's own payment-bubble flush hook (packages/core/src/nudge.ts)
      // is the structural backstop if this still loses the race (e.g. a slow
      // Telegram edit), but the ordering here should teach the right lesson
      // regardless. This rail never flipped its own bubble at all before
      // Task E3 — see editBubbleAndClear's own doc comment above.
      await editBubbleAndClear(api, r.order);
      nudgeOutboxDispatcher();
    } else if (r.status === "processing") {
      logger.info(`NOWPayments reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      await editBubbleAndClear(api, r.order);
      nudgeOutboxDispatcher();
    } else if (r.status === "stale") {
      logger.warn(`Order ${order.orderCode} was paid but is no longer PENDING — likely already delivered by the webhook, no action needed`);
    }
    // "already_processed" → another cycle/webhook handled it; nothing to do.
  } catch (err) {
    logger.error({ err }, `Order ${order.orderCode} was paid (NOWPayments) but delivery threw — admin alerted for manual action`);
    const alertOutcome = await withTimeout(
      alertAdmins(api, `⚠️ NOWPayments paid but delivery FAILED for <code>${esc(order.orderCode)}</code> — ${esc(String(err).slice(0, 200))}. Manual action needed.`),
      RECONCILE_TELEGRAM_TIMEOUT_MS,
    );
    if (alertOutcome === "timeout") {
      logger.warn(`NOWPayments reconcile gave up waiting on the admin alert for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — some admins may not have been notified`);
    }
  }
  return "ok";
}

// MAX_ORDERS_PER_CYCLE (cap on pending orders checked per cycle, oldest
// first — the webhook/IPN callback stays the PRIMARY delivery path, this
// poller only fills the gap when it can't reach the app, Task 11) and
// RECONCILE_CYCLE_TIMEOUT_MS (this rail's cycleTimeoutMs, passed to
// createPollLoop below) both now live in
// packages/core/src/payments/reconcileCycleBudget.ts as
// NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS (Task 13 review follow-up) — see
// that module for the full derivation, including the
// NOWPAYMENTS_PAYMENT_WINDOW_MINUTES sanity check (enforced as a test in
// poll-loop-wiring.test.ts). Re-exported under this file's original name so
// existing imports (the wiring test, jobs/index.ts) keep working unchanged.
//
// This rail DOES anchor a payment-instructions bubble at checkout
// (../handlers/walletTopup.ts:515, ../handlers/checkout.ts:1012) — an
// earlier version of this comment wrongly claimed it didn't, which is
// exactly why that bubble never got flipped: unlike TokoPay/PayDisini's
// `reconcileOrder`, this rail's own `reconcileOrder` above never flips it
// inline, so before the generic bubble-flip sweeper existed
// (`sweepPaidOrderBubbles`, apps/order-bot/src/jobs/index.ts, Task T2-E)
// nothing ever cleared it. That generic sweeper now covers this rail (and
// every other settled order with a stale anchor) on its own cron tick, so no
// per-rail bubble-sweep term belongs in this rail's cycle-timeout budget
// either — same as TokoPay/PayDisini after Task T2-F removed their own
// per-rail sweeps.
export const RECONCILE_CYCLE_TIMEOUT_MS = NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS;

// MAX_ORDERS_PER_CYCLE caps how many of the pending backlog one cycle checks
// against the gateway — listPendingNowpaymentsOrders orders oldest-first, so
// without rotation a backlog over the cap would starve orders 51+ until
// enough older ones expire out (followup-review-fixes-2). `cursor` rotates
// WHICH slice of that oldest-first list gets checked each cycle instead —
// same fix bybitBscConfirmationTracker.ts already applies to its own capped
// scan, reused here via rotatingCursor.ts rather than re-implemented.
const cursor = createRotatingCursor();

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const creds = await getNowpaymentsCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

  const allPending = await listPendingNowpaymentsOrders(prisma, new Date());
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
      await recordPollHealth(prisma, "nowpayments", { lastTxCount: 0, success: true }).catch(() => undefined);
    } else {
      logger.warn("NOWPayments reconcile cycle finished after its own deadline had already abandoned it — skipping the success heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
    }
    return;
  }

  const orders = cursor.next(allPending, MAX_ORDERS_PER_CYCLE);
  logger.info(
    orders.length < allPending.length
      ? `NOWPayments reconcile checking ${orders.length} of ${allPending.length} pending order(s) against the gateway (rotating window — the rest are covered over the next few cycles)`
      : `NOWPayments reconcile checking ${orders.length} pending order(s) against the gateway`,
  );

  let gatewayCalls = 0;
  let gatewayErrors = 0;
  for (const order of orders) {
    const outcome = await reconcileOrder(api, creds, order);
    if (outcome === "skipped") continue; // no gateway call made — an invoice-less order, not evidence either way
    gatewayCalls++;
    if (outcome === "gateway_error") gatewayErrors++;
  }
  cursor.advance(orders.length);

  // A cycle counts as failed only when EVERY gateway call in it failed — one
  // flaky order is normal noise; a gateway that answered zero of N calls is
  // an outage worth surfacing. The denominator is gatewayCalls, NOT
  // orders.length: an order with no hosted invoice yet never reaches the
  // gateway (reconcileOrder returns "skipped"), so counting it toward the
  // denominator let invoice-less orders dilute a real outage into a false
  // "healthy" cycle — precisely when the gateway being down also stops new
  // invoices from being created, so a mix of pre-outage (all-failed) and
  // invoice-less (skipped) orders is the EXPECTED shape of an outage, not a
  // corner case (Task 11 review follow-up, Critical #1). `gatewayCalls > 0`
  // keeps an all-skipped cycle correctly successful — there's no call to
  // have failed.
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
    await recordPollHealth(prisma, "nowpayments", {
      lastTxCount: orders.length,
      success: !allFailed,
      error: allFailed
        ? `NOWPayments gateway unreachable — all ${gatewayCalls} pending order status check(s) failed this cycle`
        : null,
    }).catch(() => undefined);
  } else {
    logger.warn("NOWPayments reconcile cycle finished after its own deadline had already abandoned it — skipping the heartbeat write so it can't overwrite the abandon-failure heartbeat already recorded");
  }
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
// own worst case (see the derivation comment above pollOnce) — 780s. Without
// this the default `max(3 * intervalMs, 60_000)` (60s at the default
// POLL_INTERVAL_SECONDS) would abandon a cycle mid-batch long before a full
// MAX_ORDERS_PER_CYCLE sweep of a slow-but-not-hung gateway could finish.
//
// `onCycleTimeout` writes the same shape of failed heartbeat the normal-path
// error branch above does (Task 11 review follow-up, Important #3): without
// it, an abandoned cycle recorded NOTHING, so a hung NOWPayments poller was
// indistinguishable from a healthy-but-quiet one until Task 12's watchdog
// (not yet landed) started comparing `lastRun` against the interval. Unlike
// binanceInternal.ts's abandon heartbeat, this rail has no backoff gate or
// rate-limit counter to preserve, so the payload is just the bare failure
// shape — `lastTxCount: 0` (never the success branch's `orders.length`; the
// cycle was abandoned mid-flight, so how many orders it actually finished
// checking is unknown).
const loop = createPollLoop({
  name: "NOWPayments reconcile",
  intervalMs: config.POLL_INTERVAL_SECONDS * 1000,
  cycleTimeoutMs: RECONCILE_CYCLE_TIMEOUT_MS,
  run: (isCurrent) => pollOnce(boundApi!, isCurrent),
  onCycleTimeout: (elapsedMs) =>
    recordPollHealth(prisma, "nowpayments", {
      lastTxCount: 0,
      success: false,
      error: `Poll cycle abandoned after ${elapsedMs}ms without finishing`,
    }).catch(() => undefined),
});

export function startPolling(api: Api): void {
  boundApi = api;
  void getNowpaymentsCreds(prisma).then((creds) => {
    if (!creds) {
      logger.info("NOWPayments reconcile disabled (no api key/ipn secret in Settings or .env) — poller idle");
      return;
    }
    logger.info(`NOWPayments reconcile poller active (every ${config.POLL_INTERVAL_SECONDS}s)`);
  }).catch((err) =>
    // Mandatory, not defensive tidiness — see the identical guard in
    // tokopayReconcile.ts's startPolling for why an unhandled rejection here
    // would take the whole bot process down at boot.
    logger.warn({ err }, "Could not read the NOWPayments credentials for the startup log, so this boot has no line saying whether the NOWPayments reconcile poller is on or idle — the poller itself is unaffected, since it re-reads the credentials at the top of every cycle"),
  );
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
