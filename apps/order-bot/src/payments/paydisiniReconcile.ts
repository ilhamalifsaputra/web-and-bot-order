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
import { langCode } from "@app/core/enums";
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { Decimal } from "@app/core/money";
import { t as coreT } from "@app/core/i18n";
import { checkTransaction } from "@app/core/payments/paydisini";
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
  clearOrderPaymentMessage,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { isPermanentBubbleEditFailure } from "../util/bubbleEditFailure";
import { paymentSuccessKb } from "../keyboards/customer";
import { createPollLoop } from "./pollLoop";
import { createRotatingCursor } from "./rotatingCursor";

type PendingOrder = Awaited<ReturnType<typeof listPendingPaydisiniOrders>>[number];

type AnchoredOrder = {
  id: number;
  orderCode: string;
  paymentMsgChatId: bigint | null;
  paymentMsgId: number | null;
  user: { language: string };
};

/**
 * Flip the anchored QR bubble to a success message, and report whether the
 * order's anchor may now be dropped. Best-effort: a photo bubble edits its
 * caption; a text-fallback bubble edits its text. Never throws — a rejected
 * edit is caught right here rather than propagating into the `withTimeout`
 * race `editBubbleAndClear` wraps this in, which is what lets that race keep
 * meaning exactly one thing ("the call hung past the deadline").
 *
 * Returns "keep_anchor" for a failure a later attempt could still get past
 * (flood control, a 5xx, a network fault, anything unrecognised), because the
 * anchor is the ONLY thing that lists this order for `sweepPaidOrderBubbles`
 * (jobs/index.ts) — dropping it here would leave the buyer staring at a stale
 * QRIS QR, for an order that is already paid and delivered, with nothing left
 * in the system that would ever retry the edit. Returns "clear_anchor" when
 * the edit landed, or when Telegram said this bubble can never accept it, so
 * a bubble the buyer deleted self-heals out of that sweep's queue instead of
 * costing it a slot every minute forever. `isPermanentBubbleEditFailure`
 * (util/bubbleEditFailure.ts) draws that line once for all five call sites
 * that hold this contract, including the twin of this function in
 * tokopayReconcile.ts.
 *
 * Both attempts' errors are classified, and either one proving the edit can
 * never land is enough — a photo/QR bubble that already shows this exact text
 * says so only through the CAPTION attempt ("message is not modified"), while
 * its text attempt answers the deliberately-not-permanent "there is no text
 * in the message to edit". Same rule `editPaymentBubble` (jobs/index.ts)
 * applies to its own two attempts.
 */
async function editBubbleToSuccess(api: Api, order: AnchoredOrder): Promise<"clear_anchor" | "keep_anchor"> {
  // No anchor to begin with: nothing to edit and nothing to strand, so the
  // caller's clear is a harmless no-op.
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return "clear_anchor";
  const lang = langCode(order.user.language);
  const chatId = Number(order.paymentMsgChatId);
  const text = coreT("checkout.payment_received", lang, { code: order.orderCode });
  const markup = paymentSuccessKb(lang);
  try {
    await api.editMessageCaption(chatId, order.paymentMsgId, { caption: text, parse_mode: "HTML", reply_markup: markup });
  } catch (captionError) {
    try {
      await api.editMessageText(chatId, order.paymentMsgId, text, { parse_mode: "HTML", reply_markup: markup });
    } catch (textError) {
      if (!isPermanentBubbleEditFailure(textError) && !isPermanentBubbleEditFailure(captionError)) {
        logger.warn(
          { err: textError },
          `PayDisini reconcile could not flip order ${order.orderCode}'s payment bubble to the success message, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`,
        );
        return "keep_anchor";
      }
      /* bubble gone/uneditable for good — the credential DM already informed the buyer */
    }
  }
  return "clear_anchor";
}

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
 * payment path — editBubbleToSuccess and alertAdmins — once a gateway call
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

/** Wait at most RECONCILE_TELEGRAM_TIMEOUT_MS for the success-bubble edit,
 * then clear the anchor only once the edit genuinely completed — a timed-out
 * edit leaves the anchor in place so the next cycle's fast path retries it,
 * the same trade-off the generic paid-order bubble sweeper
 * (`sweepPaidOrderBubbles`, apps/order-bot/src/jobs/index.ts, Task T2-E)
 * makes for its own edits — that generic sweeper is also the backstop that
 * eventually catches this order's bubble if this fast path's own edit times
 * out here. So does an edit Telegram refused for a reason that might not hold
 * next minute: `editBubbleToSuccess` never throws (it catches and classifies
 * the rejection itself), so `outcome` is either its own clear/keep verdict or
 * "timeout", the one case it cannot see. */
async function editBubbleAndClear(api: Api, order: AnchoredOrder): Promise<void> {
  const outcome = await withTimeout(editBubbleToSuccess(api, order), RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`PayDisini reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — anchor left in place so the next sweep retries`);
    return;
  }
  // "keep_anchor" already logged its own reason inside editBubbleToSuccess.
  if (outcome === "keep_anchor") return;
  await clearOrderPaymentMessage(prisma, order.id);
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
      await editBubbleAndClear(api, r.order);
    } else if (r.status === "processing") {
      logger.info(`PayDisini reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      nudgeOutboxDispatcher();
      await editBubbleAndClear(api, r.order);
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

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const creds = await getPaydisiniCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

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
  for (const order of orders) {
    const outcome = await reconcileOrder(api, creds, order);
    if (outcome === "skipped") continue; // no gateway call made — not evidence either way
    gatewayCalls++;
    if (outcome === "gateway_error") gatewayErrors++;
  }
  cursor.advance(orders.length);

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
// binanceInternal.ts's abandon heartbeat, this rail has no backoff gate or
// rate-limit counter to preserve, so the payload is just the bare failure
// shape — `lastTxCount: 0` (never the success branch's `orders.length`; the
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
