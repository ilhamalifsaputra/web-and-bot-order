// setup-env MUST be first — sets env that @app/core/config reads at import time.
import "./setup-env";

import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
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

      // The abandoned cycle rejects minutes later, well after being given up on.
      hangReject?.(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener("unhandledRejection", unhandled);
      loop.stop();
    }
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
});
