/**
 * Self-scheduling poll loop shared by every payment-gateway poller.
 *
 * The loop shape every poller used before this helper existed ("await the
 * cycle, then re-arm setTimeout") has a data dependency bug: the next timer
 * is only armed after the current cycle's promise settles. None of the
 * gateway `fetch` calls has a timeout, so a black-holed socket makes a cycle
 * hang forever, the enclosing `tick` never returns, the next `setTimeout` is
 * never armed, and the poller is silently dead until the process restarts.
 *
 * This helper fixes that with two independent mechanisms — neither is
 * sufficient alone:
 *   1. Arm the next tick's timer BEFORE running the cycle, so the schedule
 *      has no data dependency on the cycle settling. A hang can only ever
 *      be skipped by the `running` overlap guard, never block the timer.
 *   2. A per-cycle abandon deadline. Re-arming alone is not enough: without
 *      it, `running` would stay `true` forever once a cycle hangs, so every
 *      later tick would be silently skipped by the overlap guard and the
 *      poller would still be functionally dead. The deadline releases
 *      `running`, logs the hang, and fires `onCycleTimeout` so a watchdog
 *      can see a failed heartbeat instead of silence.
 *
 * Safe from double-writes after an abandon: two cycles for the same rail can
 * end up overlapping once a cycle is abandoned (its result is discarded, but
 * it keeps running in the background). This is safe because every code path
 * that moves money claims a UNIQUE constraint in the ledger before any state
 * change (`processed_binance_tx.binance_tx_id`, `processed_bybit_tx.bybit_tx_id`,
 * `processed_{tokopay,paydisini,nowpayments}_tx.trx_id`) — the second claim
 * hits a unique violation and the caller returns `already_processed`. The
 * only un-gated effects are an admin DM, `nudgeOutboxDispatcher()`, and a
 * Telegram bubble edit — all idempotent. Worst case is one duplicate admin
 * DM during a genuine hang, which is far better than a dead poller.
 */
import { logger } from "@app/core/logger";

export interface PollLoopOptions {
  /** Used verbatim inside log sentences, e.g. "TokoPay reconcile". */
  name: string;
  intervalMs: number;
  /** Defaults to max(3 * intervalMs, 60_000). */
  cycleTimeoutMs?: number;
  run: () => Promise<void>;
  /** Fired when a cycle is abandoned past its deadline; elapsedMs is the time since the cycle started. */
  onCycleTimeout?: (elapsedMs: number) => void | Promise<void>;
}

export interface PollLoop {
  start(): void;
  stop(): void;
  /** Run a cycle right now, on top of the normal schedule. No-op while a cycle is already in flight or the loop is stopped. */
  triggerNow(): void;
  /** True while a cycle is currently in flight; cleared on completion, rejection, or abandonment. */
  readonly running: boolean;
}

export function createPollLoop(opts: PollLoopOptions): PollLoop {
  const intervalMs = opts.intervalMs;
  const cycleTimeoutMs = opts.cycleTimeoutMs ?? Math.max(3 * intervalMs, 60_000);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = true;
  // Bumped by stop() so a cycle started before a stop()+start() cycle can
  // never clear the `running` flag of the loop's new generation.
  let generation = 0;

  function runCycle(): void {
    if (stopped || running) return;
    running = true;
    const myGeneration = generation;
    const startedAt = Date.now();
    let settled = false;

    const releaseIfCurrentGeneration = () => {
      if (myGeneration === generation) running = false;
    };

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, cycleTimeoutMs);
      // Not present on every timer type (e.g. browser/DOM lib typings), so
      // this must stay optional — it must never hold the process open.
      deadlineTimer.unref?.();
    });

    // A synchronous throw from opts.run() (before it returns a promise) must
    // be absorbed the same way an async rejection is, so it never becomes an
    // uncaught exception on this tick.
    let cyclePromise: Promise<void>;
    try {
      cyclePromise = opts.run();
    } catch (err) {
      cyclePromise = Promise.reject(err);
    }

    // Attached synchronously (same tick the promise is created), so a
    // rejection can never surface as an unhandled rejection — including one
    // that lands long after the cycle was abandoned by the deadline below.
    cyclePromise.then(
      () => {
        if (settled) return;
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        releaseIfCurrentGeneration();
      },
      (err) => {
        if (settled) {
          logger.warn(
            { err },
            `${opts.name} poll cycle rejected after it had already been abandoned by its deadline — ignoring, no further action needed`,
          );
          return;
        }
        settled = true;
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        logger.error(
          { err },
          `${opts.name} poll cycle threw an error — the cycle ended, polling resumes on the next tick`,
        );
        releaseIfCurrentGeneration();
      },
    );

    void deadline.then(() => {
      if (settled) return;
      settled = true;
      const elapsedMs = Date.now() - startedAt;
      logger.error(
        `${opts.name} poll cycle did not finish within ${cycleTimeoutMs}ms — abandoning it so the schedule is not blocked; it may still complete in the background and its result will be discarded`,
      );
      releaseIfCurrentGeneration();
      if (opts.onCycleTimeout) {
        void Promise.resolve()
          .then(() => opts.onCycleTimeout?.(elapsedMs))
          .catch((err) => {
            logger.error(
              { err },
              `${opts.name} onCycleTimeout hook threw an error — the hang was still recorded as abandoned, only the hook's own side effect (e.g. a watchdog heartbeat write) failed to run`,
            );
          });
      }
    });
  }

  function tick(): void {
    if (stopped) return;
    // Arm the next tick BEFORE running this cycle, so the schedule has no
    // data dependency on the cycle settling.
    timer = setTimeout(tick, intervalMs);
    runCycle();
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      timer = setTimeout(tick, intervalMs);
    },
    stop(): void {
      stopped = true;
      generation += 1;
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    triggerNow(): void {
      if (stopped) return;
      runCycle();
    },
    get running(): boolean {
      return running;
    },
  };
}
