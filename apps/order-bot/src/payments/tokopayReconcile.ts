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
import type { Api, InlineKeyboard } from "grammy";
import { config } from "@app/core/config";
import { adminIds } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { checkTransaction, qrisChargeAmount } from "@app/core/payments/tokopay";
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
  clearOrderPaymentMessage,
  recordPollHealth,
} from "@app/db";
import { esc } from "../util/format";
import { editPaymentBubble } from "../jobs";
import { settledPaymentBubble, bubbleOnPhotoFor } from "../util/delivery";
import { createPollLoop } from "./pollLoop";
import { createRotatingCursor } from "./rotatingCursor";

type PendingOrder = Awaited<ReturnType<typeof listPendingTokopayOrders>>[number];

/** What `editBubbleAndClear` needs off a settled order: the anchor to edit,
 * the row it clears afterwards, and everything `settledPaymentBubble`
 * (`util/delivery.ts`) reads to decide WHICH success message this order gets.
 * No buyer read is needed — `settledPaymentBubble` interpolates no balance
 * into either branch — so this carries no `userId`/`currency`/`totalAmount`.
 * `deliverPaidTokopayOrder` returns a full `getOrder` row, so every field
 * here is already on it; nothing in packages/db needed widening. */
type AnchoredOrder = {
  id: number;
  orderCode: string;
  kind: string;
  status: string;
  paymentMsgChatId: bigint | null;
  paymentMsgId: number | null;
  user: { language: string };
};

/**
 * Flip the anchored QR bubble to the already-composed success message
 * `bubble`, and report whether the order's anchor may now be dropped.
 *
 * HOW that bubble becomes the message is `editPaymentBubble`'s business
 * (jobs/index.ts), not this rail's: a text bubble is edited in place, while a
 * QRIS photo bubble is DELETED, then either has the message sent afresh (a
 * PRODUCT sale) or is left deleted with nothing in its place (a settled
 * WALLET_TOPUP — its outbox WALLET_TOPUP_CREDITED_DM already told the buyer,
 * so a replacement bubble here would only be a second copy of that news; Task
 * E2). `bubbleOnPhotoFor` (util/delivery.ts) makes that choice from
 * `order.kind`, the same mapping the sweeper and the buyer's own Refresh tap
 * use. Editing a photo bubble's caption instead — which is what this function
 * used to do first — succeeds at the wrong thing, because Telegram cannot turn
 * a photo message into a text one: the caption flips to "payment received"
 * while the QR image itself stays parked above it, still scannable, for an
 * order that is already paid and delivered. This rail carried its own copy of
 * that caption-then-text chain rather than calling the shared helper, and
 * since QRIS is the rail where payments are auto-confirmed most often, it was
 * the likeliest place for a buyer to end up looking at a stale QR code.
 *
 * No fallback DM either way — `bubbleOnPhotoFor` gives a PRODUCT order
 * `fallbackDm: null` explicitly, and a WALLET_TOPUP's `onPhoto: "delete"`
 * never carries the option at all (`editPaymentBubble`'s own doc comment) —
 * deliberately: a buyer reached here has already been told the news through
 * the normal delivery path (the notifier's account `.txt` or the outbox's
 * top-up DM), so a DM from here would only repeat it.
 *
 * The message itself is the caller's, not this function's: composing it needs
 * a database read for a wallet top-up (see `editBubbleAndClear`), and that
 * read has no business inside the Telegram-call timeout above.
 *
 * Returns "keep_anchor" for a failure a later attempt could still get past
 * (flood control, a 5xx, a network fault, anything unrecognised), because the
 * anchor is the ONLY thing that lists this order for `sweepPaidOrderBubbles`
 * (jobs/index.ts) — dropping it here would leave the buyer staring at a stale
 * QRIS QR, for an order that is already paid and delivered, with nothing left
 * in the system that would ever retry the edit. Returns "clear_anchor" when
 * the bubble was edited, replaced, or deleted-with-nothing-in-its-place, and
 * equally when Telegram said this bubble can never accept the message, so a
 * bubble the buyer deleted self-heals out of that sweep's queue instead of
 * costing it a slot every minute forever. `isPermanentBubbleEditFailure`
 * (util/bubbleEditFailure.ts) draws that line once for every call site that
 * holds this contract, and the helper is now the only place that consults it
 * on this path.
 *
 * Never throws: `editPaymentBubble` catches every grammY call it makes, and
 * the mapping below adds no throwing path of its own. That is what lets the
 * `withTimeout` race in `editBubbleAndClear` keep meaning exactly one thing
 * ("the call hung past the deadline").
 */
async function editBubbleToSuccess(
  api: Api,
  order: AnchoredOrder,
  bubble: { text: string; markup: InlineKeyboard },
): Promise<"clear_anchor" | "keep_anchor"> {
  // No anchor to begin with: nothing to edit and nothing to strand, so the
  // caller's clear is a harmless no-op.
  if (order.paymentMsgChatId == null || order.paymentMsgId == null) return "clear_anchor";
  const result = await editPaymentBubble(api, {
    chatId: Number(order.paymentMsgChatId),
    messageId: order.paymentMsgId,
    text: bubble.text,
    markup: bubble.markup,
    ...bubbleOnPhotoFor(order.kind),
  });
  switch (result.status) {
    case "edited":
      return "clear_anchor";
    case "replaced":
      // The message id the anchor holds was deleted, and the fresh message in
      // its place already IS the success message — re-anchoring on
      // `result.messageId` would only queue a bubble that needs nothing.
      return "clear_anchor";
    case "deleted":
      // A settled WALLET_TOPUP's QR bubble (bubbleOnPhotoFor, util/delivery.ts):
      // deleted with no replacement, because the outbox's
      // WALLET_TOPUP_CREDITED_DM already told the buyer. Nothing is left to
      // retry either way, so this clears exactly like "replaced" does.
      return "clear_anchor";
    case "dm_sent":
      // Unreachable from here twice over: this rail never passes a `fallbackDm`
      // target on the "replace" branch, and the "delete" branch has no such
      // field to pass. Still a real outcome of the shared helper, and the right
      // verdict if it ever did arrive: the buyer was told, so nothing is left
      // to retry.
      return "clear_anchor";
    case "not_edited": {
      if (result.permanent) return "clear_anchor"; // bubble gone/uneditable for good — the delivery DM already informed the buyer
      const message = `TokoPay reconcile could not flip order ${order.orderCode}'s payment bubble to the success message, and Telegram's answer does not rule out the same edit succeeding later (flood control, a server error, or a network fault) — its anchor is left in place on purpose so the paid-order bubble sweep retries the edit within a minute`;
      // `error` only carries a FALLBACK DM's failure, which this call opted
      // out of, so today it is always absent — logged when present rather than
      // as a bare `err: undefined` a reader would mistake for a lost cause.
      if (result.error === undefined) logger.warn(message);
      else logger.warn({ err: result.error }, message);
      return "keep_anchor";
    }
  }
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
 * follow-up), shared with PayDisini/NOWPayments and re-imported above, so
 * it, MAX_ORDERS_PER_CYCLE, and RECONCILE_CYCLE_TIMEOUT_MS below are all one
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
  // Which ending this bubble gets is decided by `settledPaymentBubble`
  // (util/delivery.ts) — the same mapping the background sweeper and the
  // buyer's own "🔄 Refresh Status" tap use, so a QRIS buyer can no longer be
  // told a different story than a Binance/Bybit one for the same kind of
  // order. No buyer read is needed: a wallet top-up's bubble is a neutral
  // status line that quotes no balance at all (the balance-quoting sentence
  // lives exclusively in the outbox's WALLET_TOPUP_CREDITED_DM), so the order
  // row alone is enough here.
  const bubble = settledPaymentBubble(order);
  const outcome = await withTimeout(editBubbleToSuccess(api, order, bubble), RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`TokoPay reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — anchor left in place so the next sweep retries`);
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
      await editBubbleAndClear(api, r.order);
    } else if (r.status === "processing") {
      logger.info(`TokoPay reconcile order ${order.orderCode} paid — queued for manual fulfilment`);
      nudgeOutboxDispatcher();
      await editBubbleAndClear(api, r.order);
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

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const creds = await getTokopayCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

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
// binanceInternal.ts's abandon heartbeat, this rail has no backoff gate or
// rate-limit counter to preserve, so the payload is just the bare failure
// shape — `lastTxCount: 0` (never the success branch's `orders.length`; the
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
