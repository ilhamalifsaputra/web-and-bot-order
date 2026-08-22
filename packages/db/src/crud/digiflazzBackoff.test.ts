import { describe, it, expect } from "vitest";
import {
  nextDigiflazzRecheckAt,
  DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES,
  DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES,
  DIGIFLAZZ_RECHECK_WINDOW_HOURS,
} from "./digiflazzBackoff";

describe("Digiflazz backoff schedule", () => {
  it("attempt 1 returns dispatchedAt + 2 minutes", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:00:00.000Z");
    const result = nextDigiflazzRecheckAt(dispatchedAt, 1, now);
    expect(result).toEqual(new Date("2026-08-22T10:02:00.000Z"));
  });

  it("attempt 5 returns dispatchedAt + 60 minutes (last front-loaded step)", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:00:00.000Z");
    const result = nextDigiflazzRecheckAt(dispatchedAt, 5, now);
    expect(result).toEqual(new Date("2026-08-22T11:00:00.000Z"));
  });

  it("attempt 6 returns dispatchedAt + 180 minutes (first steady-cadence step)", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:00:00.000Z");
    const result = nextDigiflazzRecheckAt(dispatchedAt, 6, now);
    expect(result).toEqual(new Date("2026-08-22T13:00:00.000Z"));
  });

  it("attempt 7 returns dispatchedAt + 300 minutes (second steady-cadence step)", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:00:00.000Z");
    const result = nextDigiflazzRecheckAt(dispatchedAt, 7, now);
    expect(result).toEqual(new Date("2026-08-22T15:00:00.000Z"));
  });

  it("returns null when candidate would exceed the 24h window", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:00:00.000Z");
    // Calculate which attempt first exceeds 24h (1440 minutes)
    // Front-loaded: [2, 5, 15, 30, 60] (5 total)
    // Steady intervals: +120 min each
    // Attempt 16: 60 + 11*120 = 1380 min (within window)
    // Attempt 17: 60 + 12*120 = 1500 min (exceeds 1440 min window)
    const result = nextDigiflazzRecheckAt(dispatchedAt, 17, now);
    expect(result).toBeNull();
  });

  it("returns a valid date for the last attempt within the 24h window", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:00:00.000Z");
    // Attempt 16 should be exactly 1380 minutes = 23 hours
    const result = nextDigiflazzRecheckAt(dispatchedAt, 16, now);
    const expectedTime = new Date(dispatchedAt.getTime() + 1380 * 60_000);
    expect(result).toEqual(expectedTime);
  });

  it("clamps to now when candidate is in the past", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const now = new Date("2026-08-22T10:15:00.000Z");
    // Attempt 1 would be 10:02:00, but now is 10:15:00, so should return now
    const result = nextDigiflazzRecheckAt(dispatchedAt, 1, now);
    expect(result).toEqual(now);
  });

  it("returns candidate exactly when now equals candidate (not clamped past)", () => {
    const dispatchedAt = new Date("2026-08-22T10:00:00.000Z");
    const candidate = new Date("2026-08-22T10:02:00.000Z");
    // Attempt 1 would be 10:02:00, and now is exactly 10:02:00
    const result = nextDigiflazzRecheckAt(dispatchedAt, 1, candidate);
    expect(result).toEqual(candidate);
  });

  it("respects DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES constant", () => {
    expect(DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES).toEqual([2, 5, 15, 30, 60]);
  });

  it("respects DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES constant", () => {
    expect(DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES).toBe(120);
  });

  it("respects DIGIFLAZZ_RECHECK_WINDOW_HOURS constant", () => {
    expect(DIGIFLAZZ_RECHECK_WINDOW_HOURS).toBe(24);
  });
});
