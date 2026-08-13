// setup-env MUST be first — sets env that @app/core/config reads at import time.
import "./setup-env";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@app/core/logger";
import { createPollLoop } from "../src/payments/pollLoop";

/**
 * createPollLoop replaces the "await then re-arm" shape shared by every
 * payment poller (see binanceInternal.ts's old startPolling/tick), which has
 * a bug: the next setTimeout is only armed after the current cycle's promise
 * settles. If a gateway fetch hangs forever, the schedule dies with it.
 *
 * This helper fixes that with two independent mechanisms: (1) the next tick
 * is armed BEFORE the cycle runs, so the schedule has no data dependency on
 * the cycle settling, and (2) a per-cycle abandon deadline releases the
 * `running` overlap guard and fires onCycleTimeout so a hang cannot wedge
 * every later tick behind a `running` flag that never clears.
 */
describe("createPollLoop", () => {
  // The loop logs at warn/error on the abandon and late-rejection paths.
  // Spying (and no-op'ing) both keeps test output clean — same pattern as
  // apps/order-bot/test/jobs.test.ts:345 — and lets individual tests assert
  // the right message actually fired instead of just trusting silence.
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("abandons a cycle that never settles and starts a fresh one on the next tick", async () => {
    vi.useFakeTimers();
    const calls: number[] = [];
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(async () => {
      calls.push(calls.length + 1);
      if (calls.length === 1) {
        await new Promise<void>((resolve) => {
          hangResolve = resolve;
        });
      }
    });
    const onCycleTimeout = vi.fn();
    const loop = createPollLoop({
      name: "Test",
      intervalMs: 1_000,
      cycleTimeoutMs: 2_500,
      run,
      onCycleTimeout,
    });

    loop.start();

    // First tick (t=1000) starts cycle 1, which hangs forever.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    // The deadline (2500ms after the cycle started, t=3500) abandons it —
    // chosen off the 1000ms tick grid so it never lands on the same virtual
    // timestamp as a scheduled tick.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onCycleTimeout).toHaveBeenCalledTimes(1);
    expect(onCycleTimeout).toHaveBeenCalledWith(2_500);
    expect(loop.running).toBe(false);
    // The abandon path actually logs, at error level.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain("did not finish within");

    // The next scheduled tick (t=4000) starts a fresh cycle.
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(2);

    loop.stop();
    hangResolve?.();
  });

  it("keeps the schedule armed while a cycle is still in flight", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 10_000, run });

    loop.start();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(loop.running).toBe(true);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    // Several more ticks fire while the cycle is still in flight.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    hangResolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    loop.stop();
  });

  it("a rejecting cycle never stops the schedule", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.reject(new Error("gateway 500")));
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 5_000, run });

    loop.start();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it("skips overlapping ticks while a cycle is in flight", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 10_000, run });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000); // tick starts cycle 1 (hangs)
    expect(run).toHaveBeenCalledTimes(1);

    // Ticks at t=2000,3000,4000 fire but must be skipped by the overlap guard.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);

    hangResolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    // The next tick after the cycle settles starts a second cycle.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("triggerNow runs a cycle immediately and is skipped while one is in flight", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const loop = createPollLoop({ name: "Test", intervalMs: 60_000, cycleTimeoutMs: 10_000, run });

    loop.start();
    loop.triggerNow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    loop.triggerNow(); // in flight — skipped
    expect(run).toHaveBeenCalledTimes(1);

    hangResolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(loop.running).toBe(false);

    loop.triggerNow(); // free again
    expect(run).toHaveBeenCalledTimes(2);

    loop.stop();
  });

  it("a cycle that settles after stop() cannot resurrect the schedule", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 5_000, run });

    loop.start();
    loop.triggerNow(); // cycle 1 starts, hangs
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    loop.stop();
    expect(loop.running).toBe(false);

    // The abandoned cycle finally settles AFTER stop() was called.
    hangResolve?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(loop.running).toBe(false);

    // No new tick should ever fire again, and run() must not be called again.
    await vi.advanceTimersByTimeAsync(100_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stop() disarms the in-flight cycle's deadline — no late onCycleTimeout, no abandon log", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const onCycleTimeout = vi.fn();
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 2_500, run, onCycleTimeout });

    loop.start();
    loop.triggerNow(); // cycle 1 starts, hangs
    expect(loop.running).toBe(true);

    loop.stop();
    expect(loop.running).toBe(false);

    // Advance well past the deadline the hung cycle would otherwise have
    // been abandoned at. A clean stop() is not a hang: nothing should log
    // and onCycleTimeout must never fire for a rail that was deliberately
    // shut down.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onCycleTimeout).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    hangResolve?.();
  });

  it("a stale cycle from before stop()+start() cannot clear the new generation's running flag", async () => {
    vi.useFakeTimers();
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    let calls = 0;
    const run = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<void>((resolve) => {
          resolveA = resolve;
        });
      }
      return new Promise<void>((resolve) => {
        resolveB = resolve;
      });
    });
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 10_000, run });

    loop.start();
    loop.triggerNow(); // cycle A starts (generation 0), hangs
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.running).toBe(true);

    loop.stop(); // bumps generation, forces running false
    loop.start(); // new generation's schedule armed

    await vi.advanceTimersByTimeAsync(1_000); // scheduled tick starts cycle B (generation 1), hangs
    expect(run).toHaveBeenCalledTimes(2);
    expect(loop.running).toBe(true);

    // Cycle A, left over from before the stop()+start(), finally settles.
    // Its completion handler must be a no-op for `running` — B is still the
    // one in flight, on a newer generation.
    resolveA?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(loop.running).toBe(true); // B's flag survived A's stale settle
    expect(run).toHaveBeenCalledTimes(2); // no third cycle started

    resolveB?.();
    loop.stop();
  });

  it("a cycle that rejects after being abandoned never surfaces as an unhandled rejection", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    let hangReject: ((err: unknown) => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          hangReject = reject;
        }),
    );
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 500, run });

    try {
      loop.start();
      loop.triggerNow(); // cycle 1 starts, hangs
      expect(loop.running).toBe(true);

      await vi.advanceTimersByTimeAsync(500); // deadline fires — cycle is abandoned
      expect(loop.running).toBe(false);

      // Nothing left for the fake schedule timer to do in this test — drop
      // it now so switching to real timers below doesn't leave a fake timer
      // handle behind.
      loop.stop();

      // The abandoned cycle rejects minutes later, well after being given up on.
      hangReject?.(new Error("late failure"));

      // Node only checks for an unhandled rejection after the microtask
      // queue drains at the end of a REAL tick. Fake timers fake that
      // checkpoint away too, so this assertion could pass even against a
      // rejection handler attached too late to matter unless we actually
      // give Node's real event loop a turn. Switch to real timers and await
      // a genuine setImmediate before asserting.
      vi.useRealTimers();
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Treat this assertion as documentation, not as a proven regression
      // gate. During review we deliberately broke pollLoop so its rejection
      // handler was attached a tick too late, and this listener STILL never
      // fired under Vitest (an equivalent standalone Node script did observe
      // it), so Vitest's own rejection instrumentation appears to intercept
      // the event before Node's checkpoint reaches us. The warn assertion
      // below is the part of this test that reliably turns red.
      expect(unhandled).not.toHaveBeenCalled();
      // The late-rejection path actually logs, at warn level.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]?.[1])).toContain("already been abandoned by its deadline");
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      loop.stop();
    }
  });

  // Task 11 review follow-up, Important #1 (Finding A): before this fix, a
  // cycle abandoned past its deadline kept running in the background and,
  // once it finally settled, a rail's own success-heartbeat write inside
  // `run()` had no way to know it had already been given up on — so a
  // retroactive `success: true` write could silently overwrite the
  // abandon-failure heartbeat pollLoop.ts itself had just recorded via
  // onCycleTimeout, resetting consecutiveFailures and making a genuinely
  // hung rail read healthy. `run` is now passed an `isCurrent()` check for
  // exactly this: it must go `false` the instant the cycle is abandoned, so
  // a rail can gate its own heartbeat write on it.
  it("passes run() an isCurrent() that flips to false once the cycle is abandoned, so a late heartbeat write can no-op", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn();
    let settleHungCycle: (() => void) | undefined;
    const run = vi.fn(
      (isCurrent: () => boolean) =>
        new Promise<void>((resolve) => {
          settleHungCycle = () => {
            // This mirrors a rail's own guarded heartbeat write — see
            // binanceInternal.ts/tokopayReconcile.ts/etc.'s `if (isCurrent())`
            // guard around their success-heartbeat write.
            if (isCurrent()) heartbeat();
            resolve();
          };
        }),
    );
    const onCycleTimeout = vi.fn();
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 2_500, run, onCycleTimeout });

    loop.start();

    // First tick starts cycle 1, which hangs.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run).toHaveBeenCalledTimes(1);

    // The deadline abandons it — onCycleTimeout fires the abandon-failure
    // heartbeat (the rail's own onCycleTimeout hook, not exercised directly
    // here — see poll-loop-wiring.test.ts for that end-to-end).
    await vi.advanceTimersByTimeAsync(2_500);
    expect(onCycleTimeout).toHaveBeenCalledTimes(1);

    // The abandoned cycle finally "completes" in the background, well after
    // being given up on. Without the fix, its guarded heartbeat call would
    // still fire here (isCurrent() didn't exist / always read true) —
    // overwriting the abandon-failure heartbeat with a retroactive success.
    settleHungCycle?.();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(heartbeat).not.toHaveBeenCalled();

    loop.stop();
  });

  it("isCurrent() stays true for a cycle that finishes inside its own deadline", async () => {
    vi.useFakeTimers();
    let observedIsCurrent: boolean | undefined;
    const run = vi.fn(async (isCurrent: () => boolean) => {
      observedIsCurrent = isCurrent();
    });
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, cycleTimeoutMs: 5_000, run });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(observedIsCurrent).toBe(true);

    loop.stop();
  });

  it("defaults cycleTimeoutMs to max(3 * intervalMs, 60_000)", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const onCycleTimeout = vi.fn();
    // intervalMs=1000 -> 3*intervalMs=3000, so the 60_000 floor applies.
    const loop = createPollLoop({ name: "Test", intervalMs: 1_000, run, onCycleTimeout });

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000); // cycle 1 starts

    // Just under the 60_000 floor — must not be abandoned yet.
    await vi.advanceTimersByTimeAsync(58_000);
    expect(onCycleTimeout).not.toHaveBeenCalled();
    expect(loop.running).toBe(true);

    // Crosses the 60_000 floor (60_000ms after the cycle started).
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onCycleTimeout).toHaveBeenCalledTimes(1);

    loop.stop();
    hangResolve?.();
  });

  it("defaults cycleTimeoutMs to 3 * intervalMs once that exceeds the 60_000 floor", async () => {
    vi.useFakeTimers();
    let hangResolve: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          hangResolve = resolve;
        }),
    );
    const onCycleTimeout = vi.fn();
    // intervalMs=30_000 -> 3*intervalMs=90_000, above the 60_000 floor, so
    // the multiplier branch (not the floor) must be exercised.
    const loop = createPollLoop({ name: "Test", intervalMs: 30_000, run, onCycleTimeout });

    loop.start();
    await vi.advanceTimersByTimeAsync(30_000); // cycle 1 starts

    // Just under the 90_000 multiplier deadline — must not be abandoned yet.
    await vi.advanceTimersByTimeAsync(89_000);
    expect(onCycleTimeout).not.toHaveBeenCalled();
    expect(loop.running).toBe(true);

    // Crosses 90_000ms after the cycle started.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onCycleTimeout).toHaveBeenCalledTimes(1);

    loop.stop();
    hangResolve?.();
  });
});
