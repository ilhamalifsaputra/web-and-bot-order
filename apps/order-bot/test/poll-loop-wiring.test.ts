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
  // nowpaymentsReconcile.ts
  getNowpaymentsCreds: vi.fn(),
  listPendingNowpaymentsOrders: vi.fn(),
  deliverPaidNowpaymentsOrder: vi.fn(),
  // tokopayReconcile.ts / paydisiniReconcile.ts / nowpaymentsReconcile.ts
  // heartbeat (Task 11) — resolved (not a bare vi.fn()) for the same reason
  // as recordBinancePollHealth above: pollOnce's normal-path writes call
  // `.catch()` on this call's return value.
  recordPollHealth: vi.fn().mockResolvedValue(undefined),
}));

import * as dbMock from "@app/db";
import * as binanceInternal from "../src/payments/binanceInternal";
import * as bybitDeposit from "../src/payments/bybitDeposit";
import * as bybitBscDeposit from "../src/payments/bybitBscDeposit";
import * as bybitBscConfirmationTracker from "../src/payments/bybitBscConfirmationTracker";
import * as tokopayReconcile from "../src/payments/tokopayReconcile";
import * as paydisiniReconcile from "../src/payments/paydisiniReconcile";
import * as nowpaymentsReconcile from "../src/payments/nowpaymentsReconcile";
import { RECONCILE_CYCLE_TIMEOUT_MS as TOKOPAY_CYCLE_TIMEOUT_MS } from "../src/payments/tokopayReconcile";
import { RECONCILE_CYCLE_TIMEOUT_MS as PAYDISINI_CYCLE_TIMEOUT_MS } from "../src/payments/paydisiniReconcile";
import { RECONCILE_CYCLE_TIMEOUT_MS as NOWPAYMENTS_CYCLE_TIMEOUT_MS } from "../src/payments/nowpaymentsReconcile";
import { BINANCE_CYCLE_TIMEOUT_MS } from "../src/payments/binanceInternal";
import { TRACKER_CYCLE_TIMEOUT_MS } from "../src/payments/bybitBscConfirmationTracker";
import { BYBIT_CYCLE_TIMEOUT_MS } from "../src/payments/bybitDeposit";
import { BYBIT_BSC_CYCLE_TIMEOUT_MS } from "../src/payments/bybitBscDeposit";

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
   * Every rail with a poll-health heartbeat wires onCycleTimeout to it, so
   * the self-heal test below can also assert the abandon heartbeat's
   * payload, not just that a fresh cycle started. The three crypto deposit
   * rails each have their own dedicated recordXPollHealth (2-arg: db, args).
   * The three QRIS reconcilers share the generic `recordPollHealth` (3-arg:
   * db, rail, args — Task 11 review follow-up, Important #3) — `healthRail`
   * below distinguishes the two call shapes for the assertion. The BSC
   * confirmation tracker has no heartbeat at all (display-only, see its own
   * module doc-comment), so it's the only rail with neither field set.
   */
  healthMockKey?: keyof typeof dbMock;
  /** Set only for the three QRIS reconcilers, whose shared `recordPollHealth`
   * mock is called as (db, rail, args) instead of (db, args). */
  healthRail?: string;
  /**
   * Rails whose `createPollLoop` call passes an explicit `cycleTimeoutMs`
   * instead of relying on the default `max(3 * intervalMs, 60_000)`: Binance
   * and the BSC confirmation tracker (Task 3 review follow-up fixes), and
   * the three QRIS reconcilers (Task 11, sized off their own
   * MAX_ORDERS_PER_CYCLE × HTTP_TIMEOUT_MS.gatewayRead + margin — see the
   * derivation comment above each rail's own `pollOnce`). Imported from each
   * rail's own exported cycle-timeout constant (`RECONCILE_CYCLE_TIMEOUT_MS`
   * for the QRIS reconcilers; `BINANCE_CYCLE_TIMEOUT_MS` /
   * `TRACKER_CYCLE_TIMEOUT_MS` for Binance and the BSC tracker — Task 11
   * review follow-up, Minor #5) rather than hardcoded, so lowering the real
   * constant in source can't silently stop failing this test. Omitted for
   * every other rail, which still uses the default.
   */
  cycleTimeoutMs?: number;
}> = [
  { name: "Binance Internal Transfer", mod: binanceInternal, hangFn: "resolveBinanceInternalConfig", intervalMs: config.POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordBinancePollHealth", cycleTimeoutMs: BINANCE_CYCLE_TIMEOUT_MS },
  { name: "Bybit Internal Transfer deposit", mod: bybitDeposit, hangFn: "resolveBybitConfig", intervalMs: config.BYBIT_POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordBybitPollHealth", cycleTimeoutMs: BYBIT_CYCLE_TIMEOUT_MS },
  { name: "Bybit BSC deposit", mod: bybitBscDeposit, hangFn: "resolveBybitBscConfig", intervalMs: config.BYBIT_BSC_POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordBybitBscPollHealth", cycleTimeoutMs: BYBIT_BSC_CYCLE_TIMEOUT_MS },
  { name: "Bybit BSC confirmation tracker", mod: bybitBscConfirmationTracker, hangFn: "resolveBybitBscTrackerConfig", intervalMs: config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS * 1000, cycleTimeoutMs: TRACKER_CYCLE_TIMEOUT_MS },
  { name: "TokoPay reconcile", mod: tokopayReconcile, hangFn: "getTokopayCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordPollHealth", healthRail: "tokopay", cycleTimeoutMs: TOKOPAY_CYCLE_TIMEOUT_MS },
  { name: "PayDisini reconcile", mod: paydisiniReconcile, hangFn: "getPaydisiniCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordPollHealth", healthRail: "paydisini", cycleTimeoutMs: PAYDISINI_CYCLE_TIMEOUT_MS },
  { name: "NOWPayments reconcile", mod: nowpaymentsReconcile, hangFn: "getNowpaymentsCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000, healthMockKey: "recordPollHealth", healthRail: "nowpayments", cycleTimeoutMs: NOWPAYMENTS_CYCLE_TIMEOUT_MS },
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

  describe.each(RAILS)("$name", ({ mod, hangFn, intervalMs, healthMockKey, healthRail, cycleTimeoutMs: railCycleTimeoutMs }) => {
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

      // Most rails still use createPollLoop's default; Binance and the BSC
      // confirmation tracker pass an explicit cycleTimeoutMs sized off their
      // own worst-case arithmetic (Task 3 review follow-up) — see the
      // derivation comments next to each rail's own createPollLoop call.
      const cycleTimeoutMs = railCycleTimeoutMs ?? Math.max(3 * intervalMs, 60_000);

      // First scheduled tick starts cycle 1, which hangs.
      await vi.advanceTimersByTimeAsync(intervalMs);
      expect(hangMock).toHaveBeenCalledTimes(1);

      // Past cycle 1's abandon deadline, the next scheduled tick must start a
      // SECOND cycle. Before this task, the old "await then re-arm" shape
      // never re-arms once a cycle hangs, so this rail would stay stuck at 1
      // call forever — the exact bug this task fixes.
      await vi.advanceTimersByTimeAsync(cycleTimeoutMs + intervalMs);
      expect(hangMock).toHaveBeenCalledTimes(2);

      // Every rail with a heartbeat also fires a poll-health write when
      // cycle 1 is abandoned (Task 11 review follow-up, Important #3, for
      // the three QRIS reconcilers). Assert the exact abandon-branch payload.
      if (healthMock) {
        expect(healthMock).toHaveBeenCalledTimes(1);
        if (healthRail) {
          // The three QRIS reconcilers share the generic `recordPollHealth`
          // (db, rail, args) — no backoff gate/rate-limit counter exists for
          // these rails, so the abandon payload is just the bare failure
          // shape (see each rail's own onCycleTimeout comment).
          expect(healthMock).toHaveBeenCalledWith(
            expect.anything(),
            healthRail,
            expect.objectContaining({
              lastTxCount: 0,
              success: false,
              error: expect.stringContaining("Poll cycle abandoned after"),
            }),
          );
        } else {
          // The three crypto rails' own recordXPollHealth (db, args).
          // `backoffUntil`/`consecutiveRateLimitHits` must be read from the
          // live backoff gate (here at its untouched, never-rate-limited
          // default of 0/null — no rate limit was simulated in this test),
          // not hardcoded to null/omitted the way the pre-fix hook did.
          // `consecutiveRateLimitHits` being present at all (rather than
          // `undefined`) is exactly what the pre-fix hook got wrong: it
          // omitted the key, so recordXPollHealth's
          // `args.consecutiveRateLimitHits ?? 0` still wrote 0 in this idle
          // state, but `objectContaining` below distinguishes "key present
          // with value 0" from "key missing" and would fail red against
          // that omission. `rateLimited: false` because an abandoned cycle
          // is a hang, not a rate-limit response — it must still count
          // toward consecutiveFailures, which a true rate-limit hit
          // deliberately does not.
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
      }
    });
  });
});

// Task 11 review follow-up, Important #1 (Finding A) — end-to-end pin for at
// least one real rail (not just the synthetic run() in poll-loop.test.ts):
// proves the actual wiring (`run: (isCurrent) => pollOnce(boundApi!,
// isCurrent)`) really does suppress a stale retroactive success. NOWPayments
// is used because its success-heartbeat write is reachable with only
// @app/db mocks (no gateway `fetch` involved) via the empty-pending-list
// branch.
describe("a rail's success heartbeat no-ops once its own cycle has been abandoned (Finding A regression pin)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    nowpaymentsReconcile.stopPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("NOWPayments reconcile: a cycle that resolves after its deadline does not overwrite the abandon-failure heartbeat with a retroactive success", async () => {
    const credsMock = vi.mocked(dbMock.getNowpaymentsCreds);
    credsMock.mockReset();
    let resolveCreds: ((v: unknown) => void) | undefined;
    // Each call gets its own pending promise — startPolling()'s fire-and-
    // forget boot check calls this once, then the loop's own cycle calls it
    // again on the scheduled tick; `resolveCreds` ends up bound to the LAST
    // call captured, which is the cycle's own (the one we want to resolve).
    credsMock.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          resolveCreds = resolve;
        }) as ReturnType<typeof dbMock.getNowpaymentsCreds>,
    );

    const listMock = vi.mocked(dbMock.listPendingNowpaymentsOrders);
    listMock.mockReset();
    listMock.mockResolvedValue([]); // empty pending list -> the success-heartbeat branch

    const healthMock = vi.mocked(dbMock.recordPollHealth);
    healthMock.mockClear();

    nowpaymentsReconcile.startPolling(fakeApi);

    const intervalMs = config.POLL_INTERVAL_SECONDS * 1000;

    // Scheduled tick starts cycle 1, which hangs on getNowpaymentsCreds.
    await vi.advanceTimersByTimeAsync(intervalMs);
    // Snapshot cycle 1's own resolver NOW, before the next advance — with
    // NOWPAYMENTS_CYCLE_TIMEOUT_MS an exact multiple of intervalMs (both
    // round numbers by construction), the next scheduled tick lands on the
    // EXACT SAME virtual timestamp cycle 1's deadline fires at, so the advance
    // below both abandons cycle 1 AND starts cycle 2 — which calls
    // getNowpaymentsCreds again and would otherwise steal `resolveCreds`.
    const resolveCycle1Creds = resolveCreds;
    expect(resolveCycle1Creds).toBeDefined();

    // Past the deadline, the cycle is abandoned — the abandon-failure
    // heartbeat is recorded exactly once (cycle 2 also starts here, per the
    // note above, and hangs on its own fresh getNowpaymentsCreds call — inert
    // for the rest of this test, cleaned up by afterEach's stopPolling()).
    await vi.advanceTimersByTimeAsync(NOWPAYMENTS_CYCLE_TIMEOUT_MS);
    expect(healthMock).toHaveBeenCalledTimes(1);
    expect(healthMock).toHaveBeenCalledWith(
      expect.anything(),
      "nowpayments",
      expect.objectContaining({ success: false, error: expect.stringContaining("Poll cycle abandoned after") }),
    );
    healthMock.mockClear();

    // Cycle 1's own (now-stale) getNowpaymentsCreds call finally resolves,
    // letting its pollOnce continue in the background straight to its
    // empty-list success-heartbeat write.
    resolveCycle1Creds?.({ apiKey: "x", ipnSecret: "y" });
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Before the Finding A fix, this would be called once more with
    // `success: true`, silently erasing the abandon-failure heartbeat above
    // and resetting consecutiveFailures — making a hung poller read healthy.
    expect(healthMock).not.toHaveBeenCalled();
  });
});

// Followup review fix #1: Binance's failure branch (fetchIncomingTransfers
// rejects) was the only one of the six deposit-poller failure/success
// branches NOT guarded by isCurrent() — Bybit Internal Transfer and Bybit BSC
// both guard their own identically-shaped failure branch (see their own
// pollOnce). Mirrors the "Finding A" success-branch pin above, but drives
// Binance's FAILURE path instead: fetchIncomingTransfers hangs (via a global
// `fetch` stub whose promise this test controls) until after the cycle's own
// deadline abandons it, then is walked through its real connect-retry budget
// (CONNECT_RETRY_ATTEMPTS=3, CONNECT_RETRY_DELAY_MS=1500ms apart) until it
// finally rejects — proving the stale rejection can no longer double-count
// the SAME failure the abandon heartbeat already recorded.
describe("Binance's failure-branch heartbeat no-ops once its own cycle has been abandoned (Finding #1 regression pin)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
    vi.spyOn(logger, "info").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    binanceInternal.stopPolling();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("a fetch failure that resolves after the cycle's deadline does not double-count the abandon-failure heartbeat", async () => {
    const cfgMock = vi.mocked(dbMock.resolveBinanceInternalConfig);
    cfgMock.mockReset();
    cfgMock.mockResolvedValue({
      enabled: true,
      receiveUid: "u",
      apiKey: "k",
      apiSecret: "s",
      apiBase: "https://api.binance.com",
      apiBaseFallbacks: [], // no fallback walk — isolates the primary host's own retry budget
      currency: "USDT",
      pollIntervalSeconds: 10,
      windowMinutes: 15,
      minAmount: null,
    });

    // Every fetch() call returns its own never-auto-settling promise; the
    // test drives each one explicitly via the captured reject function,
    // re-captured after every advance so it always refers to the attempt
    // that JUST fired (cycle 2 also calls fetch() once its own cycle starts —
    // see the snapshot-before-advancing note below, same pattern the
    // Finding A success-branch pin above uses for its own DB mock).
    let currentReject: ((err: unknown) => void) | undefined;
    const fetchMock = vi.fn(() => new Promise((_resolve, reject) => { currentReject = reject; }));
    vi.stubGlobal("fetch", fetchMock);

    const healthMock = vi.mocked(dbMock.recordBinancePollHealth);
    healthMock.mockClear();

    binanceInternal.startPolling(fakeApi);

    const intervalMs = config.POLL_INTERVAL_SECONDS * 1000;

    // Cycle 1's first (and, since it never settles, only) connect attempt.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cycle1Attempt1Reject = currentReject; // snapshot before cycle 2 can steal `currentReject`
    expect(cycle1Attempt1Reject).toBeDefined();

    // Past BINANCE_CYCLE_TIMEOUT_MS, cycle 1 is abandoned — the abandon
    // heartbeat fires exactly once. (Cycle 2 may also start here and hang on
    // its own fresh fetch() call; it's inert for the rest of this test and
    // cleaned up by afterEach's stopPolling().)
    await vi.advanceTimersByTimeAsync(BINANCE_CYCLE_TIMEOUT_MS);
    expect(healthMock).toHaveBeenCalledTimes(1);
    expect(healthMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ success: false, error: expect.stringContaining("Poll cycle abandoned after") }),
    );
    healthMock.mockClear();

    // Walk cycle 1's own (now-stale) fetchIncomingTransfers through its real
    // connect-retry budget until it finally rejects.
    cycle1Attempt1Reject?.(new Error("connect refused 1"));
    await vi.advanceTimersByTimeAsync(1500); // CONNECT_RETRY_DELAY_MS sleep -> attempt 2
    const cycle1Attempt2Reject = currentReject;
    cycle1Attempt2Reject?.(new Error("connect refused 2"));
    await vi.advanceTimersByTimeAsync(1500); // sleep -> attempt 3
    const cycle1Attempt3Reject = currentReject;
    cycle1Attempt3Reject?.(new Error("connect refused 3"));
    // apiBaseFallbacks is empty, so fallThroughMirrors rethrows immediately —
    // fetchIncomingTransfers' own promise settles on this same microtask tick.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Before the Finding #1 fix, this would be called once more with
    // `success: false` and the real connect error — silently double-counting
    // the SAME underlying failure the abandon heartbeat above already
    // recorded, and resetting backoffUntil/consecutiveRateLimitHits from
    // stale in-memory state.
    expect(healthMock).not.toHaveBeenCalled();
  }, 15_000);
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

// Task 11 review follow-up, Minor #4: RECONCILE_CYCLE_TIMEOUT_MS's own
// doc-comment in each QRIS/NOWPayments reconcile module narrates a sanity
// check against PAYMENT_WINDOW_MINUTES ("a cycle deadline shouldn't eat more
// than half an order's payment window") but hardcoded the 30-minute default
// into the narration instead of reading the live, operator-configurable
// PAYMENT_WINDOW_MINUTES (default 30 — packages/core/src/config.ts) — so an
// operator setting it to, say, 15 would silently put the deadline at 63% of
// the window (worse than the 57% a review round already rejected) with
// nothing to catch it. Enforced here against the live config values
// themselves, not hardcoded copies, so it re-fails automatically if either
// side of the ratio drifts.
//
// Each rail is checked against the key that actually governs ITS order
// expiry. NOWPayments has its own, independently tunable
// NOWPAYMENTS_PAYMENT_WINDOW_MINUTES (packages/db/src/crud/pricing.ts,
// wallet_topup.ts) — it merely happens to default to the same 30 minutes as
// the shared PAYMENT_WINDOW_MINUTES the IDR rails use. Comparing it against
// the shared key would pass today by coincidence and give false assurance the
// moment an operator tuned the NOWPayments window down on its own — exactly
// the silent misconfiguration this check exists to catch.
describe("reconcile cycle timeouts stay well clear of the payment window (Task 11 review follow-up, Minor #4)", () => {
  it.each([
    ["TokoPay", TOKOPAY_CYCLE_TIMEOUT_MS, config.PAYMENT_WINDOW_MINUTES],
    ["PayDisini", PAYDISINI_CYCLE_TIMEOUT_MS, config.PAYMENT_WINDOW_MINUTES],
    ["NOWPayments", NOWPAYMENTS_CYCLE_TIMEOUT_MS, config.NOWPAYMENTS_PAYMENT_WINDOW_MINUTES],
  ])("%s's RECONCILE_CYCLE_TIMEOUT_MS is under half of its own payment window", (_name, cycleTimeoutMs, windowMinutes) => {
    expect(cycleTimeoutMs).toBeLessThan((windowMinutes * 60_000) / 2);
  });
});

// Finding #2 (followup-review-fixes-2): the same sanity check as above,
// pinned against the two Bybit deposit rails' own new explicit cycleTimeoutMs
// (see each rail's own derivation comment above its createPollLoop call).
// BYBIT_BSC_PAYMENT_WINDOW_MINUTES (15 minutes) is the shortest payment
// window of any rail in this codebase — the tightest real check of the two.
describe("Bybit deposit rails' cycle timeouts stay well clear of their own payment window (followup-review-fixes-2, Finding #2)", () => {
  it.each([
    ["Bybit Internal Transfer", BYBIT_CYCLE_TIMEOUT_MS, config.BYBIT_PAYMENT_WINDOW_MINUTES],
    ["Bybit BSC", BYBIT_BSC_CYCLE_TIMEOUT_MS, config.BYBIT_BSC_PAYMENT_WINDOW_MINUTES],
  ])("%s's cycleTimeoutMs is under half of its own payment window", (_name, cycleTimeoutMs, windowMinutes) => {
    expect(cycleTimeoutMs).toBeLessThan((windowMinutes * 60_000) / 2);
  });
});
