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
 * against via the identical rotation). Shared by all three rails — they all
 * cap and rotate the same way. (Task 11; rotation: followup-review-fixes-2.)
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
 * NOWPayments: it DOES anchor one at checkout
 * (apps/order-bot/src/handlers/walletTopup.ts:515,
 * apps/order-bot/src/handlers/checkout.ts:1012), it just never flips it
 * inline the way TokoPay/PayDisini's `reconcileOrder` does, so the generic
 * sweeper is the only thing that ever clears it (an earlier version of this
 * comment wrongly claimed NOWPayments had no anchored bubble at all — that
 * wrong assumption is exactly why NOWPayments bubbles never got swept before
 * the generic sweeper existed). grammY's `Api` client DOES have a built-in
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
 * TokoPay's `cycleTimeoutMs` (Task 3 review follow-up shape — see
 * `bybitBscConfirmationTracker.ts`'s `TRACKER_CYCLE_TIMEOUT_MS` for the
 * worked precedent this mirrors): one cycle makes at most
 * `MAX_ORDERS_PER_CYCLE` sequential `checkTransaction` calls, each
 * individually bounded, so `MAX_ORDERS_PER_CYCLE × PER_ORDER_WORST_CASE_MS`
 * is the raw worst case for the reconcile loop (750_000ms at today's
 * cap/timeouts — pessimistically assuming every order in the batch turns
 * out freshly paid). `CYCLE_TIMEOUT_MARGIN_MS` (30s) covers the remaining DB
 * list/deliver work around the loop. Total: 750_000 + 30_000 = 780_000ms
 * (~13m).
 *
 * This used to also carry a flat sweep-worst-case term for this rail's own
 * per-rail bubble sweep (`sweepDeliveredAwaitingEdit`, deleted in Task
 * T2-F): that per-rail sweep was replaced by the generic
 * `sweepPaidOrderBubbles` (apps/order-bot/src/jobs/index.ts, Task T2-E),
 * which runs on its own cron tick rather than inside this cycle, so it no
 * longer contributes to this budget at all — this derivation is now
 * identical in shape to NOWPayments' own, below.
 *
 * Sanity check against `PAYMENT_WINDOW_MINUTES` (Task 11 review follow-up,
 * Important #3, enforced as a test —
 * apps/order-bot/test/poll-loop-wiring.test.ts — rather than just narrated
 * here per Minor #4): a cycle deadline eating more than half an order's
 * payment window means a single hung cycle can, on its own, do ZERO
 * reconciliation for most of that order's life with the safety net switched
 * off. At 780_000ms against the default 30-minute (1_800_000ms) window,
 * this is ~43% — comfortably under that line.
 */
export const TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS =
  MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

/**
 * PayDisini's `cycleTimeoutMs` — identical derivation and value to
 * TokoPay's (both rails run the same shape of reconcile loop; see
 * `TOKOPAY_RECONCILE_CYCLE_TIMEOUT_MS` above for the full derivation,
 * including why it no longer carries a bubble-sweep term as of Task T2-F).
 * Kept as its own named export rather than an alias so the two rails can be
 * tuned independently in the future without silently becoming the same
 * constant by accident.
 */
export const PAYDISINI_RECONCILE_CYCLE_TIMEOUT_MS =
  MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

/**
 * NOWPayments' `cycleTimeoutMs`: one cycle makes at most
 * `MAX_ORDERS_PER_CYCLE` sequential `getPaymentStatus` calls, each
 * individually bounded. An order whose delivery then throws also sends an
 * admin alert bounded at `RECONCILE_TELEGRAM_TIMEOUT_MS`, so
 * `PER_ORDER_WORST_CASE_MS` (15s) and the raw worst case is 750_000ms,
 * pessimistically assuming every order both answers slowly AND fails
 * delivery. `CYCLE_TIMEOUT_MARGIN_MS` (30s) covers the DB list/deliver work
 * around those calls each cycle. Total: 750_000 + 30_000 = 780_000ms — the
 * same value (and, since Task T2-F, the same shape) as TokoPay/PayDisini's
 * own derivation above. This rail's `pollOnce` never flips a bubble inline
 * either way, so no per-rail bubble-sweep term belongs in any of the three
 * rails' cycle-timeout math. That does NOT mean this rail has no anchored
 * bubble to flip — it does, anchored at checkout
 * (apps/order-bot/src/handlers/walletTopup.ts:515,
 * apps/order-bot/src/handlers/checkout.ts:1012) — only that nothing in this
 * rail's own reconcile loop flips it inline; the generic
 * `sweepPaidOrderBubbles` (apps/order-bot/src/jobs/index.ts, Task T2-E) is
 * what clears it, on its own cron schedule, independent of this budget.
 *
 * Sanity check, enforced by a test (poll-loop-wiring.test.ts) rather than
 * narrated here: this must stay under half of
 * `NOWPAYMENTS_PAYMENT_WINDOW_MINUTES` (the key that governs THIS rail's
 * order expiry — not the shared `PAYMENT_WINDOW_MINUTES` the IDR rails use,
 * though it happens to default to the same 30 minutes), or a hung cycle
 * silences the safety net for most of the window an order has to be paid
 * in.
 */
export const NOWPAYMENTS_RECONCILE_CYCLE_TIMEOUT_MS =
  MAX_ORDERS_PER_CYCLE * PER_ORDER_WORST_CASE_MS + CYCLE_TIMEOUT_MARGIN_MS;

/**
 * QRIS/IDR rails' own staleness margin (Task 12; relocated here in the Task
 * 13 review follow-up so the web-admin dashboard can read it too — see this
 * module's top-of-file doc-comment for why).
 *
 * TokoPay/PayDisini/NOWPayments are NOT like the three crypto rails
 * (Binance/Bybit/Bybit BSC — `pollHealth.ts`'s `DEFAULT_STALE_MS`, 5
 * minutes): one cycle makes up to `MAX_ORDERS_PER_CYCLE` (50) sequential,
 * individually-timed-out gateway calls, so each rail's own cycle-timeout
 * constant above is already ~820s for TokoPay/PayDisini and ~780s for
 * NOWPayments — both already well past the crypto rails' 5-minute default.
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
