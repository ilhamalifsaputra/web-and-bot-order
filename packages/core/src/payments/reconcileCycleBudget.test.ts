import { describe, expect, it, vi } from "vitest";
import { HTTP_TIMEOUT_MS } from "../http";
import {
  CYCLE_TIMEOUT_MARGIN_MS,
  MAX_ORDERS_PER_CYCLE,
  RECONCILE_TELEGRAM_TIMEOUT_MS,
  reconcileBudgetForWindow,
} from "./reconcileCycleBudget";

const PER_ORDER_MS = HTTP_TIMEOUT_MS.gatewayRead + RECONCILE_TELEGRAM_TIMEOUT_MS;

// The QRIS/IDR reconcile pollers (TokoPay, PayDisini, NOWPayments) size one
// cycle off the payment window of the rail they reconcile. The invariant
// poll-loop-wiring.test.ts enforces against the LIVE config: a cycle's
// abandon deadline stays under half of that window, so one hung cycle can
// never switch the safety net off for most of an order's life. Checked here
// for the windows the defaults have used (old 15/30, new 10/30) and every
// whole-minute window an operator could plausibly configure.
describe("reconcileBudgetForWindow", () => {
  it.each([10, 15, 30])("keeps the cycle timeout under half of a %i-minute window", (windowMinutes) => {
    const { cycleTimeoutMs } = reconcileBudgetForWindow(windowMinutes);
    expect(cycleTimeoutMs).toBeLessThan((windowMinutes * 60_000) / 2);
  });

  it("keeps the invariant for every whole-minute window from 2 to 120 minutes", () => {
    for (let windowMinutes = 2; windowMinutes <= 120; windowMinutes++) {
      const { cycleTimeoutMs } = reconcileBudgetForWindow(windowMinutes);
      expect(cycleTimeoutMs, `${windowMinutes}-minute window`).toBeLessThan((windowMinutes * 60_000) / 2);
    }
  });

  it("derives the timeout from the order cap, the per-order worst case and the flat margin", () => {
    for (const windowMinutes of [2, 10, 30, 60]) {
      const { maxOrdersPerCycle, cycleTimeoutMs } = reconcileBudgetForWindow(windowMinutes);
      expect(cycleTimeoutMs).toBe(maxOrdersPerCycle * PER_ORDER_MS + CYCLE_TIMEOUT_MARGIN_MS);
    }
  });

  it("checks 14 orders per cycle within a 240-second budget on a 10-minute window", () => {
    expect(reconcileBudgetForWindow(10)).toEqual({ maxOrdersPerCycle: 14, cycleTimeoutMs: 240_000 });
  });

  it("checks 46 orders per cycle within a 720-second budget on a 30-minute window", () => {
    expect(reconcileBudgetForWindow(30)).toEqual({ maxOrdersPerCycle: 46, cycleTimeoutMs: 720_000 });
  });

  it("never checks more than the shared ceiling, however long the window", () => {
    expect(reconcileBudgetForWindow(24 * 60).maxOrdersPerCycle).toBe(MAX_ORDERS_PER_CYCLE);
  });

  // The test environment pins PAYMENT_WINDOW_MINUTES=30 (apps/order-bot/test/
  // setup-db.ts, the root .env), so every watchdog/dashboard staleness test
  // elsewhere runs at 760 s. This one loads the real module against a config
  // parsed with NO window or interval key, i.e. the shipped 10-minute default,
  // and runs the shared staleness rule both consumers apply
  // (evaluatePollHealth with staleMs: TOKOPAY_POLL_STALE_MS).
  it("pages TokoPay's watchdog/dashboard just past 280 s at the default 10-minute window, not before", async () => {
    const { Env } = await import("../config");
    const defaults = Env.parse({ DATABASE_URL_PRISMA: "postgresql://user:pass@localhost:5432/db" });
    vi.resetModules();
    vi.doMock("../config", async (importOriginal) => ({ ...(await importOriginal<object>()), config: defaults }));
    try {
      const budget = await import("./reconcileCycleBudget");
      const { evaluatePollHealth } = await import("./pollHealth");
      expect(defaults.PAYMENT_WINDOW_MINUTES).toBe(10);
      expect(budget.TOKOPAY_POLL_STALE_MS).toBe(reconcileBudgetForWindow(10).cycleTimeoutMs + budget.QRIS_STALE_MARGIN_MS);
      expect(budget.TOKOPAY_POLL_STALE_MS).toBe(280_000);

      const now = Date.parse("2026-10-24T12:00:00.000Z");
      const heartbeatAgo = (ms: number) => {
        const at = new Date(now - ms).toISOString();
        return { lastRun: at, lastSuccessAt: at, backoffUntil: null, consecutiveFailures: 0 };
      };
      const at = (ms: number) =>
        evaluatePollHealth(heartbeatAgo(ms), { enabled: true, now, staleMs: budget.TOKOPAY_POLL_STALE_MS });

      expect(at(280_000)).toMatchObject({ status: "green", paging: false });
      expect(at(280_001)).toMatchObject({ status: "red", paging: true });
    } finally {
      vi.doUnmock("../config");
      vi.resetModules();
    }
  });

  it("still checks at least one order per cycle on a window too short to budget for", () => {
    expect(reconcileBudgetForWindow(1).maxOrdersPerCycle).toBe(1);
    expect(reconcileBudgetForWindow(0).maxOrdersPerCycle).toBe(1);
    expect(reconcileBudgetForWindow(Number.NaN).maxOrdersPerCycle).toBe(1);
  });
});
