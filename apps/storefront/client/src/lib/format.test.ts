import { describe, it, expect } from "vitest";
import { formatIdr, formatUsdt, formatUsdtAmount, formatNativeUsdt } from "./format";

describe("formatIdr", () => {
  it("formats with Rp prefix and dotted thousands (core formatIdr parity)", () => {
    expect(formatIdr("79000")).toBe("Rp79.000");
    expect(formatIdr(1250000)).toBe("Rp1.250.000");
    expect(formatIdr("500")).toBe("Rp500");
  });

  it("rounds half-up to whole rupiah", () => {
    expect(formatIdr("79000.5")).toBe("Rp79.001");
    expect(formatIdr("79000.4")).toBe("Rp79.000");
  });

  it("keeps the sign in front of Rp", () => {
    expect(formatIdr(-79000)).toBe("-Rp79.000");
  });

  it("renders em-dash for null/empty like the Nunjucks filter", () => {
    expect(formatIdr(null)).toBe("—");
    expect(formatIdr(undefined)).toBe("—");
    expect(formatIdr("")).toBe("—");
  });
});

describe("formatUsdt", () => {
  // These are parity assertions against core's `usdtFromIdr`, not independent
  // display choices — every expected value here is what the crypto rails will
  // actually charge for that Rupiah figure. If core's rounding rule changes
  // again, these must change with it in the same commit.
  it("derives USDT rounded UP to the next 0.01, shown with 2dp (core usdtFromIdr parity)", () => {
    // 16,000 IDR/USDT → Rp40.000 = $2.50 exactly, nothing to round up
    expect(formatUsdt("40000", "16000")).toBe("≈ $2.50");
    // 79,000 / 16,000 = 4.9375 → 4.94 (was 4.90 under the old 0.1 half-up step)
    expect(formatUsdt("79000", "16000")).toBe("≈ $4.94");
    // 44,500 / 16,000 = 2.78125 → 2.79, the core doc comment's own example
    expect(formatUsdt("44500", "16000")).toBe("≈ $2.79");
    // Float-error trap: (2.78125 * 100) is not exactly 278.125 in IEEE-754, so
    // a naive Math.ceil of the product can land a cent high.
    expect(formatUsdt("32000", "16000")).toBe("≈ $2.00");
    expect(formatUsdt("16000", "16000")).toBe("≈ $1.00");
    expect(formatUsdt("48000", "16000")).toBe("≈ $3.00");
  });

  it("shows a hint for a small amount that used to round away to nothing", () => {
    // Rp50 is 0.003125 USDT — floored to 0.0 and hidden under the old step,
    // now a real 0.01 the buyer will actually be charged.
    expect(formatUsdt("50", "16000")).toBe("≈ $0.01");
  });

  it("hides the hint when the rate is missing or the value is worth nothing", () => {
    expect(formatUsdt("79000", null)).toBe("");
    expect(formatUsdt("79000", "")).toBe("");
    expect(formatUsdt("0", "16000")).toBe("");
  });
});

describe("formatUsdtAmount / formatNativeUsdt", () => {
  it("rounds to max 4dp and strips trailing zeros", () => {
    expect(formatUsdtAmount(0)).toBe("0");
    expect(formatUsdtAmount(1)).toBe("1");
    expect(formatUsdtAmount(1.5)).toBe("1.5");
    expect(formatUsdtAmount(12.34)).toBe("12.34");
    expect(formatUsdtAmount(96.7)).toBe("96.7");
    expect(formatUsdtAmount(123.456789)).toBe("123.4568");
    expect(formatUsdtAmount("4.9")).toBe("4.9");
  });

  it("collapses a whole number to a bare integer", () => {
    expect(formatUsdtAmount("20.0000")).toBe("20");
  });

  it("renders em-dash for null/empty", () => {
    expect(formatUsdtAmount(null)).toBe("—");
    expect(formatUsdtAmount(undefined)).toBe("—");
    expect(formatUsdtAmount("")).toBe("—");
  });

  it("passes through a NaN-producing value unchanged", () => {
    expect(formatUsdtAmount("not-a-number")).toBe("not-a-number");
  });

  it("formatNativeUsdt appends the ' USDT' suffix, preserving the em-dash for null/empty", () => {
    expect(formatNativeUsdt(0)).toBe("0 USDT");
    expect(formatNativeUsdt(123.456789)).toBe("123.4568 USDT");
    expect(formatNativeUsdt(null)).toBe("—");
  });
});
