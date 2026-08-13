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
 * follow-up, Important #2). grammY's Api client DOES have a built-in
 * per-call timeout (`ApiClientOptions.timeoutSeconds`, verified against
 * grammy@1.43.0's `core/client.js` — an `AbortController`-backed deadline,
 * defaulting to 500s). An earlier version of this comment claimed the
 * opposite (no built-in timeout at all), which is what let the cycle-timeout
 * derivation below balloon to ~17 minutes (Task 11 review follow-up,
 * Important #3: it charged this cosmetic bubble-flip sweep the same
 * 10s-per-row budget as a money-bearing gateway call, then multiplied by the
 * full MAX_ORDERS_PER_CYCLE cap). A LATER fix then swung the other way and
 * set `client: { timeoutSeconds: 30 }` bot-wide in main.ts on the theory that
 * one knob could bound every Telegram call at once — that broke the bot's
 * own long-poll update loop (grammY applies the client timeout to
 * `getUpdates` too, with no exemption) and was reverted (Task 11 review
 * follow-up, Critical #1). There is no bot-wide bound today: this constant is
 * the ONLY thing standing between the sweep's edit calls and grammY's 500s
 * per-call default, and it does that job on its own via `withTimeout` below.
 * Exported (same reasoning as MAX_ORDERS_PER_CYCLE/RECONCILE_CYCLE_TIMEOUT_MS
 * below) so tests import the real value instead of a hardcoded copy that
 * could silently drift. */
export const SWEEP_EDIT_TIMEOUT_MS = 10_000;

/** Whole-sweep wall-clock budget (Task 11 review follow-up, Important #3):
 * this sweep is a cosmetic caption flip on orders already DELIVERED —
 * idempotent, retried next cycle, and normally an empty list — never a
 * money-bearing gateway call, so it does not deserve `cap × per-row worst
 * case` in the cycle-timeout derivation the way the reconcile loop's real
 * gateway calls do. `sweepDeliveredAwaitingEdit` checks this between rows and
 * gives up on the REST of the batch once it's exceeded, leaving their anchors
 * in place for the next cycle to retry (same accepted trade-off a per-row
 * timeout already makes). 30s is ample for a normally-empty or small sweep;
 * see RECONCILE_CYCLE_TIMEOUT_MS below for how this and SWEEP_EDIT_TIMEOUT_MS
 * combine into the cycle deadline. Exported for the same reason as
 * SWEEP_EDIT_TIMEOUT_MS above. */
export const SWEEP_TOTAL_BUDGET_MS = 30_000;

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
 * is a no-op. Bounded three ways (Task 11 review follow-up, Important #2 and
 * #3): the list itself is capped at MAX_ORDERS_PER_CYCLE, each order's edit
 * gets at most SWEEP_EDIT_TIMEOUT_MS before the sweep gives up on it and moves
 * on, and the WHOLE sweep gives up on any remaining rows once
 * SWEEP_TOTAL_BUDGET_MS has elapsed (checked between rows, not just per row —
 * the sweep's own progress is optional and safely retried next cycle, so it
 * gets a flat wall-clock budget instead of `cap × per-row worst case`). A
 * timed-out or budget-cut-off edit leaves the anchor in place so the next
 * cycle retries it — clearing only happens once an edit genuinely completes
 * (not necessarily succeeds; editBubbleToSuccess never throws).
 *
 * `opts` defaults to the exported SWEEP_EDIT_TIMEOUT_MS/SWEEP_TOTAL_BUDGET_MS
 * constants — production callers never pass it. It exists so the black-holed
 * -bubble tests can exercise the identical give-up/budget-break logic against
 * millisecond-scale values instead of the real ~10s/30s ones, with real
 * timers and real Prisma throughout (Task 11 review follow-up, Important #2:
 * the previous version of these tests genuinely slept 10s + 30s each,
 * because faking timers breaks Prisma's own I/O in this harness — the bounds
 * being tested are relative to each other, not absolute, so shrinking both
 * proportionally proves the same behavior in well under a second).
 */
export async function sweepDeliveredAwaitingEdit(
  api: Api,
  opts?: { editTimeoutMs?: number; totalBudgetMs?: number },
): Promise<void> {
  const editTimeoutMs = opts?.editTimeoutMs ?? SWEEP_EDIT_TIMEOUT_MS;
  const totalBudgetMs = opts?.totalBudgetMs ?? SWEEP_TOTAL_BUDGET_MS;
  const orders = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.TOKOPAY, MAX_ORDERS_PER_CYCLE);
  const sweepStartedAt = Date.now();
  for (const [i, order] of orders.entries()) {
    if (Date.now() - sweepStartedAt > totalBudgetMs) {
      logger.warn(`TokoPay sweep hit its ${totalBudgetMs}ms whole-sweep budget with ${orders.length - i} order(s) left unedited this cycle — their anchors are left in place so the next cycle retries them`);
      break;
    }
    const outcome = await withTimeout(editBubbleToSuccess(api, order), editTimeoutMs);
    if (outcome === "timeout") {
      logger.warn(`TokoPay sweep gave up waiting on the bubble edit for order ${order.orderCode} after ${editTimeoutMs}ms — anchor left in place so the next cycle retries`);
      continue;
    }
    await clearOrderPaymentMessage(prisma, order.id);
  }
}

/** Bound for the two Telegram calls reconcileOrder makes directly on the
 * payment path — editBubbleToSuccess and alertAdmins — once a gateway call
 * has already reported an order paid (Task 11 review follow-up, Critical
 * #1). main.ts no longer sets a bot-wide client timeout (that "wider lever"
 * was itself the regression it introduced — see buildBot() there), so
 * without an explicit bound here these calls fall back to grammY's 500s
 * per-call default and a single hung one could singlehandedly consume most
 * of a cycle's budget. Deliberately tighter than SWEEP_EDIT_TIMEOUT_MS: both
 * wrap the same kind of call, but this one sits inside the PRIMARY per-order
 * loop, whose worst case is multiplied by MAX_ORDERS_PER_CYCLE below — the
 * sweep's own bound only ever contributes its flat SWEEP_TOTAL_BUDGET_MS
 * regardless of how many orders it touches. A pure-text edit/message (no
 * media, unlike a fresh checkout's QR photo) reliably finishes in well under
 * a second in the normal case, so 5s stays generous while keeping the
 * cycle-timeout arithmetic well clear of PAYMENT_WINDOW_MINUTES (see
 * RECONCILE_CYCLE_TIMEOUT_MS below). */
export const RECONCILE_TELEGRAM_TIMEOUT_MS = 5_000;

/** Wait at most RECONCILE_TELEGRAM_TIMEOUT_MS for the success-bubble edit,
 * then clear the anchor only once the edit genuinely completed — a timed-out
 * edit leaves the anchor in place so the next cycle's sweep retries it, the
 * same trade-off sweepDeliveredAwaitingEdit already makes for its own edits. */
async function editBubbleAndClear(api: Api, order: AnchoredOrder): Promise<void> {
  const outcome = await withTimeout(editBubbleToSuccess(api, order), RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`TokoPay reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — anchor left in place so the next sweep retries`);
    return;
  }
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
// HTTP_TIMEOUT_MS.gatewayRead (10s). An order that comes back paid can then
// make ONE more bounded Telegram call inline — editBubbleToSuccess or
// alertAdmins, mutually exclusive per order (see editBubbleAndClear /
// RECONCILE_TELEGRAM_TIMEOUT_MS above), both wrapped in withTimeout at 5s
// since Task 11 review follow-up, Critical #1 removed main.ts's bot-wide
// client timeout. So PER_ORDER_WORST_CASE_MS is their sum (15s), and
// MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS is the raw worst case for
// the reconcile loop (750_000ms at today's cap/timeouts — pessimistically
// assuming every order in the batch turns out freshly paid).
//
// sweepDeliveredAwaitingEdit runs alongside it — Task 11 review follow-up,
// Important #3 corrected an earlier version of this derivation that charged
// the sweep `MAX_ORDERS_PER_CYCLE × SWEEP_EDIT_TIMEOUT_MS` (another
// 500_000ms, on top of the reconcile loop's own worst case — a false
// premise: see SWEEP_EDIT_TIMEOUT_MS's own doc-comment for why treating a
// cosmetic bubble-flip sweep as deserving a money-bearing gateway call's
// budget was the real bug). The sweep now contributes its OWN flat worst
// case instead: SWEEP_TOTAL_BUDGET_MS + one more in-flight
// SWEEP_EDIT_TIMEOUT_MS (the budget is only checked BETWEEN rows, so the row
// in flight when the budget is crossed still gets to finish) = 40_000ms.
//
// +30s margin covers the remaining DB list/deliver work around both loops.
const PER_ORDER_WORST_CASE_MS = HTTP_TIMEOUT_MS.gatewayRead + RECONCILE_TELEGRAM_TIMEOUT_MS;
const SWEEP_WORST_CASE_MS = SWEEP_TOTAL_BUDGET_MS + SWEEP_EDIT_TIMEOUT_MS;
const CYCLE_TIMEOUT_MARGIN_MS = 30_000;
/** MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS (reconcile, 750_000) +
 * SWEEP_WORST_CASE_MS (sweep, 40_000) + margin (30_000) = 820_000 (~13m40s) —
 * passed to `createPollLoop` below as this rail's `cycleTimeoutMs`. Exported
 * (Task 11 review follow-up, Minor #5) so the wiring test imports the real
 * value instead of a hardcoded copy that could silently drift from it.
 *
 * Sanity check against PAYMENT_WINDOW_MINUTES (Task 11 review follow-up,
 * Important #3, enforced as a test rather than just narrated here per Minor
 * #4 — see poll-loop-wiring.test.ts): a cycle deadline eating more than half
 * an order's payment window means a single hung cycle can, on its own, do
 * ZERO reconciliation for most of that order's life with the safety net
 * switched off — the signal the arithmetic above has left reality (this is
 * exactly how the previous ~17m10s value was found: 1_030_000ms is 57% of
 * the default 30-minute window). At 820_000ms against the same default
 * 30-minute (1_800_000ms) window, this is ~46% — still comfortably under
 * that line, though closer to it than the pre-Critical-#1 570_000ms (~32%)
 * was: bounding the payment-path Telegram calls costs real cycle-timeout
 * budget, it doesn't eliminate the need for one. */
export const RECONCILE_CYCLE_TIMEOUT_MS =
  MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + SWEEP_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

export async function pollOnce(api: Api, isCurrent: () => boolean = () => true): Promise<void> {
  const creds = await getTokopayCreds(prisma);
  if (!creds) return; // rail genuinely off — no heartbeat; its watchdog is gated on credentials too

  const orders = await listPendingTokopayOrders(prisma, new Date(), MAX_ORDERS_PER_CYCLE);
  if (!orders.length) {
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

  // Catches orders the storefront webhook delivered (the bubble flip never
  // happens on the web — CLAUDE.md "never send Telegram from the web").
  // Left unguarded: the sweep's own effects (a Telegram bubble edit) are
  // already idempotent, same as every other post-abandon side effect
  // pollLoop.ts's module doc-comment documents as safe.
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
// derivation comment above pollOnce) — 820s. Without this the default
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
  });
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
