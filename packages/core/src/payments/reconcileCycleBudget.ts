/**
 * Shared cycle-timeout / staleness-threshold arithmetic for the three QRIS
 * and IDR reconcile pollers (TokoPay, PayDisini, NOWPayments).
 *
 * Relocated here (Task 13 review follow-up) from
 * apps/order-bot/src/payments/{tokopay,paydisini,nowpayments}Reconcile.ts
 * and apps/order-bot/src/jobs/index.ts: `apps/web-admin` cannot import from
 * `apps/order-bot`, so as long as these numbers lived only in order-bot, the
 * web-admin dashboard's Business Health card had no way to read a QRIS
 * rail's real staleness threshold and silently fell back to
 * `evaluatePollHealth`'s 5-minute default meant for the crypto rails — the
 * exact "three consumers, three different rules" divergence
 * `pollHealth.ts`'s own module doc-comment says this branch exists to kill,
 * reappeared at the seam between the watchdog task (Task 12) and the
 * dashboard task (Task 6). Living here instead means the reconcile pollers
 * themselves, the order-bot watchdog (`jobs/index.ts`), and the web-admin
 * dashboard endpoint (`routes/api/dashboard.ts`) all import the exact same
 * numbers — there is exactly one place any of this is computed.
 *
 * Pure: no Prisma, no `@app/db` import, no app-specific import — only
 * `HTTP_TIMEOUT_MS` (./http.ts sibling) and `config` (../config.ts), both
 * already part of `@app/core`, so this file is safe for both apps to import.
 */
import { config } from "../config";
import { HTTP_TIMEOUT_MS } from "../http";

/**
 * Cap on how many pending orders one reconcile cycle checks against the
 * gateway, bounding one cycle's worth of gateway round-trips regardless of
 * backlog size. Each rail's own webhook/IPN callback is still its PRIMARY
 * delivery path (see that rail's reconcile module doc-comment); this poller
 * only fills the gap when that callback can't reach the app.
 *
 * Each rail lists its pending backlog oldest-first (closest to
 * auto-cancelling), but does NOT always check the same oldest N orders —
 * `createRotatingCursor` (apps/order-bot/src/payments/rotatingCursor.ts)
 * rotates WHICH slice of that list this cap covers each cycle, so a backlog
 * over the cap still gets full coverage within
 * `ceil(backlog / MAX_ORDERS_PER_CYCLE)` cycles instead of orders beyond the
 * cap being starved indefinitely — with more than MAX_ORDERS_PER_CYCLE
 * concurrently-pending orders, an always-oldest-first scan would leave the
 * webhook/IPN fallback effectively off for the newer ones for up to a whole
 * payment window (followup-review-fixes-2; the same head-of-list starvation
 * bybitBscConfirmationTracker.ts's own MAX_ORDERS_PER_CYCLE already guards
 * against via the identical rotation). (Task 11; rotation:
 * followup-review-fixes-2.)
 *
 * Since the payment-TTL change this is the CEILING, not every rail's cap:
 * each reconcile rail checks `reconcileBudgetForWindow(<its window>)
 * .maxOrdersPerCycle` orders (below), which is lower on a short window. The
 * generic paid-order bubble sweeper (`sweepPaidOrderBubbles`,
 * apps/order-bot/src/jobs/index.ts) still batches by this ceiling — it runs
 * on its own cron tick, outside any reconcile cycle's budget.
 */
export const MAX_ORDERS_PER_CYCLE = 50;

/**
 * Wait at most this long for a Telegram call on the reconcile path (a
 * success-bubble edit, or an admin alert on a delivery failure). grammY's
 * own client default is 500s — far longer than any rail's whole cycle
 * budget below — so without this bound a single hung Telegram call could
 * eat nearly an entire cycle single-handedly (Task 11 review follow-up,
 * Critical #1 removed the bot-wide client timeout that used to guard this,
 * because it also broke the bot's own long-poll update loop). Shared by all
 * three rails.
 */
export const RECONCILE_TELEGRAM_TIMEOUT_MS = 5_000;

/**
 * Per-order worst case charged by the cycle-timeout derivations below: one
 * bounded gateway status check (`HTTP_TIMEOUT_MS.gatewayRead`, 10s) plus,
 * for an order that comes back paid, ONE more bounded Telegram call inline
 * (`RECONCILE_TELEGRAM_TIMEOUT_MS`, 5s) — mutually exclusive per order (a
 * success-bubble edit OR an admin alert, never both). 15s total. Shared by
 * all three rails.
 */
const PER_ORDER_WORST_CASE_MS = HTTP_TIMEOUT_MS.gatewayRead + RECONCILE_TELEGRAM_TIMEOUT_MS;

/**
 * Flat margin added on top of a rail's raw per-order worst case, covering
 * the remaining DB list/deliver work around the reconcile loop each cycle.
 * Shared by all three rails.
 */
export const CYCLE_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Per-edit budget for waiting on a sweep bubble edit (Task 11 review
 * follow-up, Important #2). Originally TokoPay/PayDisini-only; since Task
 * T2-F removed each rail's own per-rail sweep (`sweepDeliveredAwaitingEdit`),
 * this now belongs to the generic paid-order bubble sweeper
 * (`sweepPaidOrderBubbles`, apps/order-bot/src/jobs/index.ts, Task T2-E),
 * which covers every payment method that anchors a bubble — including
 * NOWPayments: it anchors one at checkout
 * (apps/order-bot/src/handlers/walletTopup.ts:515,
 * apps/order-bot/src/handlers/checkout.ts:1012) and, since Task E3, flips it
 * inline the same way TokoPay/PayDisini's `reconcileOrder` always has (see
 * `editBubbleAndClear`, apps/order-bot/src/payments/nowpaymentsReconcile.ts)
 * — before that task this rail was the one exception that never flipped its
 * own bubble at all, so a delivered order's bubble sat stale until the
 * generic sweeper's next cron tick (up to ~60s later); this sweeper remains
 * the backstop for whatever any rail's own fast path misses, on every rail
 * alike. grammY's `Api` client DOES have a built-in
 * per-call timeout (`ApiClientOptions.timeoutSeconds`, verified against
 * grammy@1.43.0's `core/client.js` — an `AbortController`-backed deadline,
 * defaulting to 500s). There is no bot-wide bound today (an earlier attempt
 * to set one bot-wide broke the bot's own long-poll update loop and was
 * reverted, Task 11 review follow-up, Critical #1): this constant is the
 * ONLY thing standing between the sweep's edit calls and grammY's 500s
 * per-call default.
 */
export const SWEEP_EDIT_TIMEOUT_MS = 10_000;

/**
 * Whole-sweep wall-clock budget (Task 11 review follow-up, Important #3):
 * the sweep is a cosmetic caption flip on orders already
 * DELIVERED/PROCESSING — idempotent, retried next cycle, and normally an
 * empty list — never a money-bearing gateway call, so it does not deserve
 * `cap × per-row worst case` in the cycle-timeout derivation the way the
 * reconcile loop's real gateway calls do. Originally TokoPay/PayDisini-only;
 * since Task T2-F this is used by the generic paid-order bubble sweeper
 * (`sweepPaidOrderBubbles`, apps/order-bot/src/jobs/index.ts, Task T2-E),
 * which checks this between rows and gives up on the rest of the batch once
 * it's exceeded, leaving those anchors in place for the next cycle to retry.
 */
export const SWEEP_TOTAL_BUDGET_MS = 30_000;

/**
 * Share of a rail's payment window one reconcile cycle may take before it is
 * abandoned (owner-approved TTL change, Game Top-up refactor Phase 4).
 *
 * The invariant (enforced as a test against the live config —
 * apps/order-bot/test/poll-loop-wiring.test.ts — and for every plausible
 * window in reconcileCycleBudget.test.ts): a cycle deadline must stay UNDER
 * HALF of the payment window of the orders it reconciles. A deadline eating
 * more than half the window means a single hung cycle can, on its own, do
 * ZERO reconciliation for most of an order's life with the safety net
 * switched off (Task 11 review follow-up, Important #3). 40% keeps a tenth of
 * the window spare for the poll interval and the abandon-heartbeat write.
 *
 * Before the TTL change every rail used a fixed `MAX_ORDERS_PER_CYCLE` (50)
 * x `PER_ORDER_WORST_CASE_MS` (15s) + 30s = 780s, which was ~43% of the old
 * 30-minute default but 130% of a 10-minute window. The budget is therefore
 * derived from the window instead of being one constant.
 */
export const RECONCILE_WINDOW_SHARE = 0.4;

export interface ReconcileCycleBudget {
  /** Pending orders one cycle checks against the gateway (the rotating cursor's slice size). */
  maxOrdersPerCycle: number;
  /** The cycle's abandon deadline, passed as `cycleTimeoutMs` to `createPollLoop`. */
  cycleTimeoutMs: number;
}

/**
 * One QRIS/IDR reconcile rail's cycle budget, derived from the payment window
 * (minutes) that governs that rail's order expiry.
 *
 * One cycle makes at most `maxOrdersPerCycle` sequential gateway status
 * checks, each charged `PER_ORDER_WORST_CASE_MS` (15s: one bounded gateway
 * read plus at most one bounded Telegram call — pessimistically assuming
 * every order in the batch turns out freshly paid), plus
 * `CYCLE_TIMEOUT_MARGIN_MS` (30s) for the DB list/deliver work around the
 * loop. So the cap is the largest whole number of orders whose worst case
 * still fits in `RECONCILE_WINDOW_SHARE` of the window, clamped to
 * `[1, MAX_ORDERS_PER_CYCLE]`, and the timeout is that cap's own worst case:
 *
 *   maxOrdersPerCycle = clamp(floor((window x 0.4 - 30s) / 15s), 1, 50)
 *   cycleTimeoutMs    = maxOrdersPerCycle x 15s + 30s
 *
 *   10-minute window -> 14 orders, 240s (40% of 600s)
 *   30-minute window -> 46 orders, 720s (40% of 1800s)
 *
 * Capping fewer orders per cycle does not leave any order unreconciled: each
 * rail's `createRotatingCursor` rotates which slice of the oldest-first
 * pending list the cap covers, so a backlog over the cap is fully covered
 * within `ceil(backlog / maxOrdersPerCycle)` cycles. On the healthy path a
 * cycle takes seconds (a gateway read answers well under its 10s bound), so
 * 14 orders per `POLL_INTERVAL_SECONDS` tick still sweeps a 100-order backlog
 * in about eight cycles — a couple of minutes, inside a 10-minute window. The
 * webhook/IPN callback stays each rail's PRIMARY delivery path; this poller
 * only fills the gap when that callback can't reach the app.
 *
 * The floor of one order keeps the poller alive on a misconfigured tiny
 * window; the under-half invariant then holds only for windows longer than
 * 1.5 minutes (one order's 45s worst case), which every real rail exceeds.
 */
export function reconcileBudgetForWindow(windowMinutes: number): ReconcileCycleBudget {
  const affordable = Math.floor(
    (windowMinutes * 60_000 * RECONCILE_WINDOW_SHARE - CYCLE_TIMEOUT_MARGIN_MS) / PER_ORDER_WORST_CASE_MS,
  );
  const maxOrdersPerCycle = Number.isFinite(affordable)
    ? Math.min(MAX_ORDERS_PER_CYCLE, Math.max(1, affordable))
    : 1;
  return {
    maxOrdersPerCycle,
    cycleTimeoutMs: maxOrdersPerCycle * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS,
  };
}

/**
 * TokoPay's budget, sized off `PAYMENT_WINDOW_MINUTES` (the window
 * `finalizeOrderPayment` leaves on a QRIS order — TokoPay and PayDisini share
 * it). See `reconcileBudgetForWindow` for the derivation.
 *
 * This used to also carry a flat sweep-worst-case term for this rail's own
 * per-rail bubble sweep (`sweepDeliveredAwaitingEdit`, deleted in Task
 * T2-F): that per-rail sweep was replaced by the generic
 * `sweepPaidOrderBubbles` (apps/order-bot/src/jobs/index.ts, Task T2-E),
 * which runs on its own cron tick rather than inside this cycle, so it no
 * longer contributes to this budget at all.
 */
const TOKOPAY_RECONCILE_BUDGET = reconcileBudgetForWindow(config.PAYMENT_WINDOW_MINUTES);
export const TOKOPAY_MAX_ORDERS_PER_CYCLE = TOKOPAY_RECONCILE_BUDGET.maxOrdersPerCycle;
export const TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS = TOKOPAY_RECONCILE_BUDGET.cycleTimeoutMs;

/**
 * PayDisini's budget — identical derivation and window to TokoPay's (both
 * rails run the same shape of reconcile loop). Kept as its own named exports
 * rather than aliases so the two rails can be tuned independently in the
 * future without silently becoming the same constant by accident.
 */
const PAYDISINI_RECONCILE_BUDGET = reconcileBudgetForWindow(config.PAYMENT_WINDOW_MINUTES);
export const PAYDISINI_MAX_ORDERS_PER_CYCLE = PAYDISINI_RECONCILE_BUDGET.maxOrdersPerCycle;
export const PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS = PAYDISINI_RECONCILE_BUDGET.cycleTimeoutMs;

/**
 * NOWPayments' budget, sized off `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` — the
 * key that governs THIS rail's order expiry (packages/db/src/crud/pricing.ts,
 * wallet_topup.ts), not the shared `PAYMENT_WINDOW_MINUTES` the IDR rails
 * use. Sizing it off the shared key would pass by coincidence while both
 * defaults matched, and give false assurance the moment an operator tuned
 * one of them on its own.
 *
 * One cycle makes at most `maxOrdersPerCycle` sequential `getPaymentStatus`
 * calls plus — for an order that comes back paid — exactly ONE more bounded
 * Telegram call inline: either the success-bubble edit (`editBubbleAndClear`,
 * apps/order-bot/src/payments/nowpaymentsReconcile.ts, Task E3) when delivery
 * succeeds, or the admin alert when delivery throws — mutually exclusive per
 * order, exactly the shape `PER_ORDER_WORST_CASE_MS` (15s) describes. The
 * generic `sweepPaidOrderBubbles` (apps/order-bot/src/jobs/index.ts, Task
 * T2-E) remains the backstop for whatever this rail's own fast path still
 * misses (a timed-out or flood-controlled edit), on its own cron schedule,
 * independent of this budget.
 */
const NOWPAYMENTS_RECONCILE_BUDGET = reconcileBudgetForWindow(config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES);
export const NOWPAYMENTS_MAX_ORDERS_PER_CYCLE = NOWPAYMENTS_RECONCILE_BUDGET.maxOrdersPerCycle;
export const NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS = NOWPAYMENTS_RECONCILE_BUDGET.cycleTimeoutMs;

/**
 * QRIS/IDR rails' own staleness margin (Task 12; relocated here in the Task
 * 13 review follow-up so the web-admin dashboard can read it too — see this
 * module's top-of-file doc-comment for why).
 *
 * TokoPay/PayDisini/NOWPayments are NOT like the three crypto rails
 * (Binance/Bybit/Bybit BSC — `pollHealth.ts`'s `DEFAULT_STALE_MS`, 5
 * minutes): one cycle makes up to `MAX_ORDERS_PER_CYCLE` (50) sequential,
 * individually-timed-out gateway calls, so each rail's own cycle-timeout
 * constant above scales with its payment window (240s on a 10-minute window,
 * 720s on a 30-minute one) — at the longer windows well past the crypto
 * rails' 5-minute default, and never something that default was sized for.
 *
 * A rail's heartbeat is written exactly once per cycle — at the end
 * (success or failure) or, for a hung cycle, at its own cycle-timeout
 * abandon point — never mid-cycle. So a single legitimately slow cycle (a
 * large backlog, a briefly slow gateway) can run for several minutes past
 * the 5-minute mark and write NOTHING in the meantime, not because it's
 * stuck, but because there is nothing to write until it finishes. Watching
 * these three rails with the crypto rails' 5-minute threshold would page
 * admins (or, since this branch, flip the dashboard red) on ordinary
 * slowness, not just a genuine hang — exactly the spurious page/red-card
 * this constant exists to prevent.
 *
 * Fix: each QRIS rail's own `staleMs` is its own cycle-timeout constant plus
 * a flat margin. The margin only needs to cover the abandon-heartbeat write
 * itself and ordinary tick-timing jitter (the loop's next cycle can start up
 * to one `POLL_INTERVAL_SECONDS` after the previous heartbeat) — it does NOT
 * need to re-add the cycle-timeout constant's own safety margin, since that
 * constant already IS the point past which a cycle is abandoned and a
 * heartbeat is guaranteed to be written.
 *
 * `POLL_INTERVAL_SECONDS` is operator-settable (packages/core/src/config.ts,
 * default 10) — the margin is derived FROM it, not hardcoded past it, so
 * raising the interval widens the margin along with the jitter it exists to
 * absorb instead of silently eating the slack this comment promises (a
 * hardcoded margin sized for the 10s default would have exactly zero slack
 * left at a 60s interval, and page/redden on ordinary near-deadline cycles
 * above that). The flat 30s on top covers the abandon-heartbeat write
 * itself.
 *
 * This only widens the STALENESS rule (`evaluatePollHealth`'s rule 5) — the
 * "failing every cycle" rule (`consecutiveFailures ≥ failureThreshold`)
 * still pages/reddens within a few cycles of a real gateway outage
 * regardless of this value, since failures don't wait for staleness at all.
 */
export const QRIS_STALE_MARGIN_MS = config.POLL_INTERVAL_SECONDS * 1000 + 30_000;

/**
 * Final per-rail staleness thresholds, passed as `staleMs` to
 * `evaluatePollHealth` by BOTH `apps/order-bot/src/jobs/index.ts`'s watchdog
 * (`tokopayPollWatchdog` and its two twins) and
 * `apps/web-admin/src/routes/api/dashboard.ts`'s Business Health card — the
 * one and only place either consumer gets this number from. Exported (not
 * just derived inline at each call site) so both consumers, and every test
 * that pins against them, import the real currently-computed value instead
 * of a hardcoded-by-hand literal that could silently drift from it.
 */
export const TOKOPAY_POLL_STALE_MS = TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS + QRIS_STALE_MARGIN_MS;
export const PAYDISINI_POLL_STALE_MS = PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS + QRIS_STALE_MARGIN_MS;
export const NOWPAYMENTS_POLL_STALE_MS = NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS + QRIS_STALE_MARGIN_MS;
