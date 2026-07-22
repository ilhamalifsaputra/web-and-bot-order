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
  it("derives USDT rounded to the nearest 0.1, shown with 2dp", () => {
    // 16,000 IDR/USDT → Rp40.000 = $2.5 (the documented core example)
    expect(formatUsdt("40000", "16000")).toBe("≈ $2.50");
    // 79,000 / 16,000 = 4.9375 → 4.9
    expect(formatUsdt("79000", "16000")).toBe("≈ $4.90");
  });

  it("hides the hint when the rate is missing or the value is negligible", () => {
    expect(formatUsdt("79000", null)).toBe("");
    expect(formatUsdt("79000", "")).toBe("");
    expect(formatUsdt("50", "16000")).toBe(""); // rounds below $0.01
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
