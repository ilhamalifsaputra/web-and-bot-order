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
  recordBinancePollHealth: vi.fn(),
  resolveBinanceInternalConfig: vi.fn(),
  enqueueNotification: vi.fn(),
  getUser: vi.fn(),
  // bybitDeposit.ts
  listPendingBybitOrders: vi.fn(),
  deliverPaidBybitOrder: vi.fn(),
  markUnderpaidBybit: vi.fn(),
  recordUnmatchedBybitTx: vi.fn(),
  recordBybitPollHealth: vi.fn(),
  resolveBybitConfig: vi.fn(),
  // bybitBscDeposit.ts
  listInFlightBybitBscOrders: vi.fn(),
  deliverPaidBybitBscOrder: vi.fn(),
  markUnderpaidBybitBsc: vi.fn(),
  recordBybitBscPaymentDetected: vi.fn(),
  recordUnmatchedBybitBscTx: vi.fn(),
  recordBybitBscPollHealth: vi.fn(),
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
}> = [
  { name: "Binance Internal Transfer", mod: binanceInternal, hangFn: "resolveBinanceInternalConfig", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
  { name: "Bybit Internal Transfer deposit", mod: bybitDeposit, hangFn: "resolveBybitConfig", intervalMs: config.BYBIT_POLL_INTERVAL_SECONDS * 1000 },
  { name: "Bybit BSC deposit", mod: bybitBscDeposit, hangFn: "resolveBybitBscConfig", intervalMs: config.BYBIT_BSC_POLL_INTERVAL_SECONDS * 1000 },
  { name: "Bybit BSC confirmation tracker", mod: bybitBscConfirmationTracker, hangFn: "resolveBybitBscTrackerConfig", intervalMs: config.BYBIT_BSC_TRACKER_POLL_INTERVAL_SECONDS * 1000 },
  { name: "TokoPay reconcile", mod: tokopayReconcile, hangFn: "getTokopayCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
  { name: "PayDisini reconcile", mod: paydisiniReconcile, hangFn: "getPaydisiniCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
  { name: "NOWPayments reconcile", mod: nowpaymentsReconcile, hangFn: "getNowpaymentsCreds", intervalMs: config.POLL_INTERVAL_SECONDS * 1000 },
];

// This suite MUST run before "payment pollers self-heal..." below: it relies
// on every rail's module-level loop never having had startPolling() called
// yet (genuine pre-boot state). If it ran after that suite, the other
// suite's afterEach (which calls stopPolling() on every rail regardless of
// which one it actually started) would leave every loop's `stopped` flag
// already true, and this suite would pass for the wrong reason.
describe("triggerImmediatePoll before startPolling is an intentional no-op", () => {
  // Only the four rails with triggerImmediatePoll — the three QRIS
  // reconcilers never exposed it. Per the task brief: createPollLoop's
  // `stopped` starts `true`, so triggerNow() before start() is a no-op. The
  // only callers (handlers/checkout.ts, handlers/walletTopup.ts) are only
  // reachable after main.ts's boot sequence has already run every rail's
  // startPolling() synchronously (no `await` in between) — so this is safe,
  // not a behavior change any real caller can observe.
  const RAILS_WITH_TRIGGER: Array<{ name: string; mod: PollModule; hangFn: keyof typeof dbMock }> = [
    { name: "Binance Internal Transfer", mod: binanceInternal, hangFn: "resolveBinanceInternalConfig" },
    { name: "Bybit Internal Transfer deposit", mod: bybitDeposit, hangFn: "resolveBybitConfig" },
    { name: "Bybit BSC deposit", mod: bybitBscDeposit, hangFn: "resolveBybitBscConfig" },
    { name: "Bybit BSC confirmation tracker", mod: bybitBscConfirmationTracker, hangFn: "resolveBybitBscTrackerConfig" },
  ];

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

  describe.each(RAILS)("$name", ({ mod, hangFn, intervalMs }) => {
    it("re-arms the schedule and starts a fresh cycle instead of dying when a cycle hangs forever", async () => {
      const hangMock = vi.mocked(dbMock[hangFn] as unknown as (...a: unknown[]) => Promise<unknown>);
      hangMock.mockReset();
      hangMock.mockReturnValue(new Promise(() => {})); // never resolves — simulates a black-holed cycle

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
    });
  });
});
