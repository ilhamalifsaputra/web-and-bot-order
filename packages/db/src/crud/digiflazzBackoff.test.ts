import { describe, it, expect } from "vitest";
import {
  nextDigiflazzRecheckAt,
  DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS,
  DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES,
  DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES,
  DIGIFLAZZ_RECHECK_WINDOW_HOURS,
} from "./digiflazzBackoff";

const T0 = new Date("2026-08-22T10:00:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe("Digiflazz backoff schedule", () => {
  it("front-loaded steps are +10s, +30s, +1m, +2m, +5m, +15m, +30m, +60m", () => {
    const expected = [10, 30, 60, 120, 300, 900, 1800, 3600];
    expected.forEach((seconds, i) => {
      expect(nextDigiflazzRecheckAt(T0, i + 1, T0)).toEqual(at(seconds));
    });
  });

  it("attempt 9 is the first steady-cadence step (+60m + 120m)", () => {
    expect(nextDigiflazzRecheckAt(T0, 9, T0)).toEqual(at(3 * 3600));
  });

  it("attempt 10 is the second steady-cadence step (+60m + 240m)", () => {
    expect(nextDigiflazzRecheckAt(T0, 10, T0)).toEqual(at(5 * 3600));
  });

  it("last attempt inside the 24h window is attempt 19 (+23h) and attempt 20 returns null", () => {
    // 60m + 11 * 120m = 1380m = 23h; 60m + 12 * 120m = 1500m > 1440m.
    expect(nextDigiflazzRecheckAt(T0, 19, T0)).toEqual(at(23 * 3600));
    expect(nextDigiflazzRecheckAt(T0, 20, T0)).toBeNull();
  });

  it("clamps to now when candidate is in the past", () => {
    const now = new Date("2026-08-22T10:15:00.000Z");
    expect(nextDigiflazzRecheckAt(T0, 1, now)).toEqual(now);
  });

  it("returns candidate exactly when now equals candidate (not clamped past)", () => {
    expect(nextDigiflazzRecheckAt(T0, 1, at(10))).toEqual(at(10));
  });

  it("exposes the schedule in seconds", () => {
    expect(DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS).toEqual([10, 30, 60, 120, 300, 900, 1800, 3600]);
  });

  it("keeps the legacy minutes export derived from the seconds schedule", () => {
    expect(DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES).toEqual(DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS.map((s) => s / 60));
  });

  it("respects DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES constant", () => {
    expect(DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES).toBe(120);
  });

  it("respects DIGIFLAZZ_RECHECK_WINDOW_HOURS constant", () => {
    expect(DIGIFLAZZ_RECHECK_WINDOW_HOURS).toBe(24);
  });
});
