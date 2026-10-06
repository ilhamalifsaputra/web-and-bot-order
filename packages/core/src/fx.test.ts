/**
 * Edge cases for the pure FX helpers in `fx.ts`. The main-path behaviour of
 * `validateUsdIdrRate`, `roundRateToStep` and `applyUsdtSpread` is also covered
 * in `core.test.ts`; this file pins the boundaries those tests leave implicit
 * (exact-cap deltas, unusable bounds, near-total spreads), because a manually
 * typed rate is now judged by the same validator (web-admin settings route).
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "./money";
import { applyUsdtSpread, roundRateToStep, validateUsdIdrRate, type FxRateBounds } from "./fx";

const d = (v: Decimal.Value) => new Decimal(v);
const bounds: FxRateBounds = { min: d("8000"), max: d("40000"), maxDeltaPct: d("5") };

describe("validateUsdIdrRate", () => {
  it("not_a_number for NaN and both infinities", () => {
    expect(validateUsdIdrRate(d(NaN), null, bounds)).toEqual({ reason: "not_a_number" });
    expect(validateUsdIdrRate(d(Infinity), null, bounds)).toEqual({ reason: "not_a_number" });
    expect(validateUsdIdrRate(d(-Infinity), null, bounds)).toEqual({ reason: "not_a_number" });
  });

  it("not_positive for zero, negative zero and negatives, even with no band configured", () => {
    const none: FxRateBounds = { min: null, max: null, maxDeltaPct: null };
    expect(validateUsdIdrRate(d("0"), null, none)).toEqual({ reason: "not_positive" });
    expect(validateUsdIdrRate(d("-0"), null, none)).toEqual({ reason: "not_positive" });
    expect(validateUsdIdrRate(d("-1"), null, bounds)).toEqual({ reason: "not_positive" });
  });

  it("below_min carries the floor; the floor itself is accepted", () => {
    const failure = validateUsdIdrRate(d("7999.99"), null, bounds);
    expect(failure?.reason).toBe("below_min");
    expect(failure?.reason === "below_min" && failure.min.toString()).toBe("8000");
    expect(validateUsdIdrRate(d("8000"), null, bounds)).toBeNull();
  });

  it("above_max carries the ceiling; the ceiling itself is accepted", () => {
    const failure = validateUsdIdrRate(d("40000.01"), null, bounds);
    expect(failure?.reason).toBe("above_max");
    expect(failure?.reason === "above_max" && failure.max.toString()).toBe("40000");
    expect(validateUsdIdrRate(d("40000"), null, bounds)).toBeNull();
  });

  it("ignores a non-positive or non-finite bound rather than rejecting everything", () => {
    const broken: FxRateBounds = { min: d("0"), max: d("-5"), maxDeltaPct: d(NaN) };
    expect(validateUsdIdrRate(d("1"), d("16000"), broken)).toBeNull();
    expect(validateUsdIdrRate(d("99999999"), d("16000"), broken)).toBeNull();
  });

  it("delta: a move exactly at the cap passes, just past it fails with the measured figures", () => {
    // 16000 -> 16800 is exactly +5%.
    expect(validateUsdIdrRate(d("16800"), d("16000"), bounds)).toBeNull();
    const failure = validateUsdIdrRate(d("16801"), d("16000"), bounds);
    expect(failure?.reason).toBe("delta_too_large");
    if (failure?.reason !== "delta_too_large") throw new Error("unreachable");
    expect(failure.subject.toString()).toBe("16801");
    expect(failure.lastKnown.toString()).toBe("16000");
    expect(failure.maxDeltaPct.toString()).toBe("5");
    expect(failure.deltaPct.toString()).toBe("5.00625");
  });

  it("delta: skipped when lastKnown is null or unusable", () => {
    expect(validateUsdIdrRate(d("39000"), null, bounds)).toBeNull();
    expect(validateUsdIdrRate(d("39000"), d("0"), bounds)).toBeNull();
    expect(validateUsdIdrRate(d("39000"), d(NaN), bounds)).toBeNull();
  });

  it("band is checked before delta: an out-of-band rate reports the band, not the move", () => {
    expect(validateUsdIdrRate(d("50000"), d("16000"), bounds)?.reason).toBe("above_max");
  });
});

describe("roundRateToStep", () => {
  it("rounds half-up to the nearest multiple of the step", () => {
    expect(roundRateToStep(d("16249.99"), 100).toString()).toBe("16200");
    expect(roundRateToStep(d("16250"), "100").toString()).toBe("16300");
    expect(roundRateToStep(d("16243.7"), d("50")).toString()).toBe("16250");
  });

  it("returns the rate unrounded for a zero, negative, non-finite or unparseable step", () => {
    for (const step of [0, "-100", "abc", "", Infinity, NaN] as Decimal.Value[]) {
      expect(roundRateToStep(d("16243.7"), step).toString()).toBe("16243.7");
    }
  });
});

describe("applyUsdtSpread", () => {
  it("lowers the rate by bps/10000 (the protective direction)", () => {
    expect(applyUsdtSpread(d("16000"), 100).toString()).toBe("15840");
    expect(applyUsdtSpread(d("16000"), "1.5").toString()).toBe("15997.6");
  });

  it("is a no-op for blank, zero, negative or unparseable bps", () => {
    for (const bps of ["", "   ", "0", "-50", "abc"] as Decimal.Value[]) {
      expect(applyUsdtSpread(d("16000"), bps).toString()).toBe("16000");
    }
  });

  it("is a no-op for bps >= 10000, which would zero or invert the rate", () => {
    expect(applyUsdtSpread(d("16000"), 10000).toString()).toBe("16000");
    expect(applyUsdtSpread(d("16000"), "10000.5").toString()).toBe("16000");
    expect(applyUsdtSpread(d("16000"), "25000").toString()).toBe("16000");
  });

  it("just under 10000 bps is applied as-is and leaves a near-zero rate for the sanity band to catch", () => {
    // Not clamped: 9999 bps keeps 0.01% of the rate. Only the band
    // (validateUsdIdrRate's below_min) stops this from being saved.
    const spread = applyUsdtSpread(d("16000"), 9999);
    expect(spread.toString()).toBe("1.6");
    expect(validateUsdIdrRate(spread, null, bounds)?.reason).toBe("below_min");
  });
});
