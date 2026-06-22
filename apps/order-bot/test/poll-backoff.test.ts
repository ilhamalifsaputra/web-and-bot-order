import { describe, expect, it } from "vitest";
import { createBackoffGate } from "../src/payments/pollBackoff";

describe("createBackoffGate", () => {
  it("starts clear: no skip, zero hit count", () => {
    const gate = createBackoffGate();
    expect(gate.shouldSkip(Date.now())).toBe(false);
    expect(gate.hitCount).toBe(0);
    expect(gate.backoffUntil).toBe(0);
  });

  it("doubles the delay on each consecutive hit, capped, then resets on success", () => {
    const gate = createBackoffGate({ baseMs: 3_000, capMs: 30_000 });
    const now = 1_000_000;

    let r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 3_000, hitCount: 1, delayMs: 3_000 });

    r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 6_000, hitCount: 2, delayMs: 6_000 });

    r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 12_000, hitCount: 3, delayMs: 12_000 });

    r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 24_000, hitCount: 4, delayMs: 24_000 });

    // Would be 48_000 uncapped — clamped to capMs.
    r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 30_000, hitCount: 5, delayMs: 30_000 });

    r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 30_000, hitCount: 6, delayMs: 30_000 });

    gate.recordSuccess();
    expect(gate.hitCount).toBe(0);
    expect(gate.backoffUntil).toBe(0);

    // A fresh hit after recovery starts back at the base delay, not the cap.
    r = gate.recordRateLimit(now);
    expect(r).toEqual({ backoffUntil: now + 3_000, hitCount: 1, delayMs: 3_000 });
  });

  it("shouldSkip is true strictly inside the backoff window and false at/after it", () => {
    const gate = createBackoffGate({ baseMs: 1_000 });
    const now = 1_000_000;
    gate.recordRateLimit(now);

    expect(gate.shouldSkip(now)).toBe(true);
    expect(gate.shouldSkip(now + 999)).toBe(true);
    expect(gate.shouldSkip(now + 1_000)).toBe(false);
    expect(gate.shouldSkip(now + 5_000)).toBe(false);
  });

  it("respects custom baseMs/capMs options", () => {
    const gate = createBackoffGate({ baseMs: 500, capMs: 1_000 });
    const now = 0;
    expect(gate.recordRateLimit(now).delayMs).toBe(500);
    expect(gate.recordRateLimit(now).delayMs).toBe(1_000); // doubled (1000) hits the cap
    expect(gate.recordRateLimit(now).delayMs).toBe(1_000); // stays at the cap
  });

  it("recordSuccess on an already-clear gate is a no-op", () => {
    const gate = createBackoffGate();
    gate.recordSuccess();
    expect(gate.hitCount).toBe(0);
    expect(gate.backoffUntil).toBe(0);
  });
});
