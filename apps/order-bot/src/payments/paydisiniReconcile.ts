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
import { checkTransaction } from "@app/core/payments/paydisini";
import {
  MAX_ORDERS_PER_CYCLE,
  RECONCILE_TELEGRAM_TIMEOUT_MS,
  SWEEP_EDIT_TIMEOUT_MS,
  SWEEP_TOTAL_BUDGET_MS,
  PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS,
} from "@app/core/payments/reconcileCycleBudget";
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

// SWEEP_EDIT_TIMEOUT_MS (per-edit budget) and SWEEP_TOTAL_BUDGET_MS
// (whole-sweep wall-clock budget) — Task 11 review follow-up, Important #2
// and #3 — now live in packages/core/src/payments/reconcileCycleBudget.ts
// (Task 13 review follow-up), shared with TokoPay's identical sweep and with
// the cycle-timeout/staleness-threshold derivations both the watchdog and
// the web-admin dashboard read; see that module for the full reasoning
// behind both values. Re-imported above so this file's own logic
// (sweepDeliveredAwaitingEdit below) and RECONCILE_CYCLE_TIMEOUT_MS's
// derivation still read from a single canonical source.

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
 * Sweep DELIVERED PayDisini orders whose bubble hasn't been flipped yet
 * (catches webhook deliveries). Idempotent: clears the anchor after editing so
 * a re-run is a no-op. Bounded three ways (Task 11 review follow-up,
 * Important #2 and #3): the list itself is capped at MAX_ORDERS_PER_CYCLE,
 * each order's edit gets at most SWEEP_EDIT_TIMEOUT_MS before the sweep gives
 * up on it and moves on, and the WHOLE sweep gives up on any remaining rows
 * once SWEEP_TOTAL_BUDGET_MS has elapsed (checked between rows, not just per
 * row — the sweep's own progress is optional and safely retried next cycle,
 * so it gets a flat wall-clock budget instead of `cap × per-row worst case`).
 * A timed-out or budget-cut-off edit leaves the anchor in place so the next
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
  const orders = await listDeliveredOrdersAwaitingEdit(prisma, PaymentMethod.PAYDISINI, MAX_ORDERS_PER_CYCLE);
  const sweepStartedAt = Date.now();
  for (const [i, order] of orders.entries()) {
    if (Date.now() - sweepStartedAt > totalBudgetMs) {
      logger.warn(`PayDisini sweep hit its ${totalBudgetMs}ms whole-sweep budget with ${orders.length - i} order(s) left unedited this cycle — their anchors are left in place so the next cycle retries them`);
      break;
    }
    const outcome = await withTimeout(editBubbleToSuccess(api, order), editTimeoutMs);
    if (outcome === "timeout") {
      logger.warn(`PayDisini sweep gave up waiting on the bubble edit for order ${order.orderCode} after ${editTimeoutMs}ms — anchor left in place so the next cycle retries`);
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
 * RECONCILE_CYCLE_TIMEOUT_MS below).
 *
 * RECONCILE_TELEGRAM_TIMEOUT_MS itself now lives in
 * packages/core/src/payments/reconcileCycleBudget.ts (Task 13 review
 * follow-up), shared with TokoPay/NOWPayments and re-imported above, so it,
 * MAX_ORDERS_PER_CYCLE, and RECONCILE_CYCLE_TIMEOUT_MS below are all one
 * canonical value the web-admin dashboard can also read. */
export { MAX_ORDERS_PER_CYCLE, RECONCILE_TELEGRAM_TIMEOUT_MS, SWEEP_EDIT_TIMEOUT_MS, SWEEP_TOTAL_BUDGET_MS };

/** Wait at most RECONCILE_TELEGRAM_TIMEOUT_MS for the success-bubble edit,
 * then clear the anchor only once the edit genuinely completed — a timed-out
 * edit leaves the anchor in place so the next cycle's sweep retries it, the
 * same trade-off sweepDeliveredAwaitingEdit already makes for its own edits. */
async function editBubbleAndClear(api: Api, order: AnchoredOrder): Promise<void> {
  const outcome = await withTimeout(editBubbleToSuccess(api, order), RECONCILE_TELEGRAM_TIMEOUT_MS);
  if (outcome === "timeout") {
    logger.warn(`PayDisini reconcile gave up waiting on the bubble edit for order ${order.orderCode} after ${RECONCILE_TELEGRAM_TIMEOUT_MS}ms — anchor left in place so the next sweep retries`);
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

  // Catches orders the storefront webhook delivered (the bubble flip never
  // happens on the web — CLAUDE.md "never send Telegram from the web").
  // Left unguarded: the sweep's own effects (a Telegram bubble edit) are
  // already idempotent, same as every other post-abandon side effect
  // pollLoop.ts's module doc-comment documents as safe.
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
// own worst case for BOTH the reconcile loop and the sweep (see the
// derivation comment above pollOnce) — 820s. Without this the default
// `max(3 * intervalMs, 60_000)` (60s at the default POLL_INTERVAL_SECONDS)
// would abandon a cycle mid-batch long before a full MAX_ORDERS_PER_CYCLE
// sweep of a slow-but-not-hung gateway could finish.
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
  });
  loop.start();
}

export function stopPolling(): void {
  loop.stop();
}
