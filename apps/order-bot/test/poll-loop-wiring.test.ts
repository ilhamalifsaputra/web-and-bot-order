// setup-env MUST be first — sets env that @app/core/config reads at import time.
import "./setup-env";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { logger } from "@app/core/logger";
import { config } from "@app/core/config";

/**
 * @app/db is fully mocked: every export any of the seven payment modules
 * pulls in at import time needs SOME value here (even if never called),
 * because ESM binds these at module-evaluation time, not lazily. Only the
 * "hang point" function for whichever rail a given test targets is ever
 * actually invoked — everything else stays an inert vi.fn() the hung cycle
 * never reaches.
 */
vi.mock("@app/db", () => ({
  prisma: {},
  // binanceInternal.ts
  listPendingInternalOrders: vi.fn(),
  deliverPaidInternalOrder: vi.fn(),
  markUnderpaid: vi.fn(),
  recordUnmatchedTx: vi.fn(),
  // Resolved (not a bare vi.fn()): the onCycleTimeout hooks in
  // binanceInternal/bybitDeposit/bybitBscDeposit call `.catch()` on this
  // call's return value. A bare vi.fn() returns undefined, and
  // `undefined.catch` throws a TypeError the moment a hung cycle crosses its
  // abandon deadline — silently swallowed by pollLoop.ts's own error
  // handling, so the self-heal suite below would still show green while
  // three of the seven hooks were actually crashing every time they fired.
  recordBinancePollHealth: vi.fn().mockResolvedValue(undefined),
  resolveBinanceInternalConfig: vi.fn(),
  enqueueNotification: vi.fn(),
  getUser: vi.fn(),
  // bybitDeposit.ts
  listPendingBybitOrders: vi.fn(),
  deliverPaidBybitOrder: vi.fn(),
  markUnderpaidBybit: vi.fn(),
  recordUnmatchedBybitTx: vi.fn(),
  recordBybitPollHealth: vi.fn().mockResolvedValue(undefined), // see recordBinancePollHealth comment above
  resolveBybitConfig: vi.fn(),
  // bybitBscDeposit.ts
  listInFlightBybitBscOrders: vi.fn(),
  deliverPaidBybitBscOrder: vi.fn(),
  markUnderpaidBybitBsc: vi.fn(),
  recordBybitBscPaymentDetected: vi.fn(),
  recordUnmatchedBybitBscTx: vi.fn(),
  recordBybitBscPollHealth: vi.fn().mockResolvedValue(undefined), // see recordBinancePollHealth comment above
  resolveBybitBscConfig: vi.fn(),
  // bybitBscConfirmationTracker.ts
  listTrackedBybitBscOrders: vi.fn(),
  recordBybitBscConfirmationProgress: vi.fn(),
  recordBybitBscTrackingStale: vi.fn(),
  enqueueOrderPipelineFailed: vi.fn(),
  resolveBybitBscTrackerConfig: vi.fn(),
  // tokopayReconcile.ts / paydisiniReconcile.ts (shared helpers)
  getTokopayCreds: vi.fn(),
  listPendingTokopayOrders: vi.fn(),
  deliverPaidTokopayOrder: vi.fn(),
  getPaydisiniCreds: vi.fn(),
  listPendingPaydisiniOrders: vi.fn(),
  deliverPaidPaydisiniOrder: vi.fn(),
  listDeliveredOrdersAwaitingEdit: vi.fn(),
  clearOrderPaymentMessage: vi.fn(),
  // nowpaymentsReconcile.ts
  getNowpaymentsCreds: vi.fn(),
  listPendingNowpaymentsOrders: vi.fn(),
  deliverPaidNowpaymentsOrder: vi.fn(),
}));

import * as dbMock from "@app/db";
import * as binanceInternal from "../src/payments/binanceInternal";
import * as bybitDeposit from "../src/payments/bybitDeposit";
import * as bybitBscDeposit from "../src/payments/bybitBscDeposit";
import * as bybitBscConfirmationTracker from "../src/payments/bybitBscConfirmationTracker";
import * as tokopayReconcile from "../src/payments/tokopayReconcile";
import * as paydisiniReconcile from "../src/payments/paydisiniReconcile";
import * as nowpaymentsReconcile from "../src/payments/nowpaymentsReconcile";

const fakeApi = {} as Api;

type PollModule = {
  startPolling: (api: Api) => void;
  stopPolling: () => void;
  triggerImmediatePoll?: (api: Api) => void;
};

/**
 * One entry per rail. `hangFn` is the name of that rail's FIRST DB call inside
 * pollOnce (per the task brief) — mocked to return a promise that never
 * resolves, so a cycle "hangs" the same way a black-holed gateway fetch would
 * (fetch timeouts are Task 3; this task only fixes the scheduler around them).
 * `intervalMs` mirrors each rail's own config knob so the test's timer
 * advances land exactly on that rail's real schedule.
 */
const RAILS: Array<{
  name: string;
  mod: PollModule;
  hangFn: keyof typeof dbMock;
  intervalMs: number;
  /**
   * Only the three crypto deposit rails wire onCycleTimeout to a poll-health
   * heartbeat write (the QRIS reconcilers and the BSC confirmation tracker
   * don't have one yet — see the "No `onCycleTimeout`" comments in those
   * files). Set for those three so the self-heal test below can also assert
   * the abandon heartbeat's payload, not just that a fresh cycle started.
   */
  healthMockKey?: keyof typeof dbMock;
}> = [
  { name: "Binance Internal Transfer", mod: binanceInternal, hangFn: "resolveBinanceInternalConfig", intervalMs: config.POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordBinancePollHealth" },
  { name: "Bybit Internal Transfer deposit", mod: bybitDeposit, hangFn: "resolveBybitConfig", intervalMs: config.BYBIT_POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordBybitPollHealth" },
  { name: "Bybit BSC deposit", mod: bybitBscDeposit, hangFn: "resolveBybitBscConfig", intervalMs: config.BYBIT_BSC_POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordBybitBscPollHealth" },
  { name: "Bybit BSC confirmation tracker", mod: bybitBscConfirmationTracker, hangFn: "resolveBybitBscTrackerConfig", intervalMs: config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS * 1000 },
  { name: "TokoPay reconcile", mod: tokopayReconcile, hangFn: "getTokopayCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
  { name: "PayDisini reconcile", mod: paydisiniReconcile, hangFn: "getPaydisiniCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
  { name: "NOWPayments reconcile", mod: nowpaymentsReconcile, hangFn: "getNowpaymentsCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
];

// Only the four rails with triggerImmediatePoll — the three QRIS
// reconcilers never exposed it. Shared by both the "before startPolling"
// no-op suite and the "after startPolling" positive suite below.
const RAILS_WITH_TRIGGER: Array<{ name: string; mod: PollModule; hangFn: keyof typeof dbMock }> = [
  { name: "Binance Internal Transfer", mod: binanceInternal, hangFn: "resolveBinanceInternalConfig" },
  { name: "Bybit Internal Transfer deposit", mod: bybitDeposit, hangFn: "resolveBybitConfig" },
  { name: "Bybit BSC deposit", mod: bybitBscDeposit, hangFn: "resolveBybitBscConfig" },
  { name: "Bybit BSC confirmation tracker", mod: bybitBscConfirmationTracker, hangFn: "resolveBybitBscTrackerConfig" },
];

// This suite MUST run before "payment pollers self-heal..." below: it relies
// on every rail's module-level loop never having had startPolling() called
// yet (genuine pre-boot state). If it ran after that suite, the other
// suite's afterEach (which calls stopPolling() on every rail regardless of
// which one it actually started) would leave every loop's `stopped` flag
// already true, and this suite would pass for the wrong reason.
describe("triggerImmediatePoll before startPolling is an intentional no-op", () => {
  // Per the task brief: createPollLoop's `stopped` starts `true`, so
  // triggerNow() before start() is a no-op. The only callers
  // (handlers/checkout.ts, handlers/walletTopup.ts) are only reachable after
  // main.ts's boot sequence has already run every rail's startPolling()
  // synchronously (no `await` in between) — so this is safe, not a behavior
  // change any real caller can observe.

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each(RAILS_WITH_TRIGGER)("$name", ({ mod, hangFn }) => {
    it("does not run a cycle when triggerImmediatePoll is called before startPolling", () => {
      const hangMock = vi.mocked(dbMock[hangFn] as unknown as (...a: unknown[]) => Promise<unknown>);
      hangMock.mockReset();
      hangMock.mockReturnValue(new Promise(() => {}));

      mod.triggerImmediatePoll!(fakeApi);

      expect(hangMock).not.toHaveBeenCalled();
    });
  });
});

describe("payment pollers self-heal from a hung cycle via createPollLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const { mod } of RAILS) mod.stopPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each(RAILS)("$name", ({ mod, hangFn, intervalMs, healthMockKey }) => {
    it("re-arms the schedule and starts a fresh cycle instead of dying when a cycle hangs forever", async () => {
      const hangMock = vi.mocked(dbMock[hangFn] as unknown as (...a: unknown[]) => Promise<unknown>);
      hangMock.mockReset();
      hangMock.mockReturnValue(new Promise(() => {})); // never resolves — simulates a black-holed cycle

      const healthMock = healthMockKey ? vi.mocked(dbMock[healthMockKey] as unknown as (...a: unknown[]) => Promise<unknown>) : undefined;
      healthMock?.mockClear();

      mod.startPolling(fakeApi);
      // Some rails fire a one-off, fire-and-forget boot-time config check
      // (for the boot log) that also calls this same DB function — drop that
      // call so only cycle-driven calls are counted below.
      hangMock.mockClear();

      const cycleTimeoutMs = Math.max(3 * intervalMs, 60_000);

      // First scheduled tick starts cycle 1, which hangs.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(hangMock).toHaveBeenCalledTimes(1);

      // Past cycle 1's abandon deadline, the next scheduled tick must start a
      // SECOND cycle. Before this task, the old "await then re-arm" shape
      // never re-arms once a cycle hangs, so this rail would stay stuck at 1
      // call forever — the exact bug this task fixes.
      await vi.advanceTimersByTimeAsync(cycleTimeoutMs + intervalMs);
      expect(hangMock).toHaveBeenCalledTimes(2);

      // The three crypto rails also fire a poll-health heartbeat write when
      // cycle 1 is abandoned. Assert the exact abandon-branch payload —
      // `backoffUntil`/`consecutiveRateLimitHits` must be read from the live
      // backoff gate (here at its untouched, never-rate-limited default of
      // 0/null — no rate limit was simulated in this test), not hardcoded to
      // null/omitted the way the pre-fix hook did. `consecutiveRateLimitHits`
      // being present at all (rather than `undefined`) is exactly what the
      // pre-fix hook got wrong: it omitted the key, so recordXPollHealth's
      // `args.consecutiveRateLimitHits ?? 0` still wrote 0 in this idle
      // state, but `objectContaining` below distinguishes "key present with
      // value 0" from "key missing" and would fail red against that
      // omission. `rateLimited: false` because an abandoned cycle is a hang,
      // not a rate-limit response — it must still count toward
      // consecutiveFailures, which a true rate-limit hit deliberately does
      // not.
      if (healthMock) {
        expect(healthMock).toHaveBeenCalledTimes(1);
        expect(healthMock).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            lastTxCount: 0,
            backoffUntil: null,
            consecutiveRateLimitHits: 0,
            rateLimited: false,
            success: false,
            error: expect.stringContaining("Poll cycle abandoned after"),
          }),
        );
      }
    });
  });
});

// This suite runs after the self-heal suite above, so every rail's loop has
// already been through at least one start()/stop() cycle — startPolling()
// here is a genuine restart, not first boot. That's fine: the assertion only
// cares that triggerImmediatePoll runs a cycle immediately once the loop is
// started, on top of the normal schedule, with no timer advance.
describe("triggerImmediatePoll after startPolling runs a cycle immediately", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    for (const { mod } of RAILS_WITH_TRIGGER) mod.stopPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each(RAILS_WITH_TRIGGER)("$name", ({ mod, hangFn }) => {
    it("calls the rail's own delegate exactly once when triggerImmediatePoll is called after startPolling", () => {
      const hangMock = vi.mocked(dbMock[hangFn] as unknown as (...a: unknown[]) => Promise<unknown>);
      hangMock.mockReset();
      // Hang rather than resolve: this only needs to prove the cycle STARTED
      // (the delegate was reached), and a hung promise can't itself trigger
      // a second, unwanted call before the assertion runs.
      hangMock.mockReturnValue(new Promise(() => {}));

      mod.startPolling(fakeApi);
      // startPolling's own boot-time config check may call this same DB
      // function once — drop that call so only triggerImmediatePoll's own
      // cycle is counted below.
      hangMock.mockClear();

      mod.triggerImmediatePoll!(fakeApi);

      // No vi.advanceTimersByTimeAsync — the whole point is that this ran
      // synchronously, on demand, not on the next scheduled tick. A rail
      // whose triggerImmediatePoll dropped `boundApi = api` or delegated to
      // the wrong loop method would leave this at 0 calls.
      expect(hangMock).toHaveBeenCalledTimes(1);
    });
  });
});
