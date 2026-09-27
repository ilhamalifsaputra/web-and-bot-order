import { describe, it, expect } from "vitest";
import { formatIdr, formatUsdt, formatUsdtAmount, formatNativeUsdt, formatPriceFor, formatOrderAmount } from "./format";

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

describe("formatPriceFor", () => {
  // currency === "IDR": identical to formatIdr — today's behavior, unchanged.
  it("currency IDR: same Rp string formatIdr would produce", () => {
    expect(formatPriceFor("79000", "IDR", "16000")).toBe(formatIdr("79000"));
    expect(formatPriceFor("79000", "IDR", "16000")).toBe("Rp79.000");
  });

  // currency === null: no preference chosen — same primary as today (Rp),
  // the "≈ $" hint is Price.tsx's own concern, not this helper's.
  it("currency null: same Rp string as today, regardless of fx", () => {
    expect(formatPriceFor("79000", null, "16000")).toBe("Rp79.000");
    expect(formatPriceFor("79000", null, null)).toBe("Rp79.000");
  });

  // currency === "USD": ceil-to-0.01, same rounding formatUsdt uses — parity
  // pinned against the exact same fixtures format.test.ts already asserts for
  // formatUsdt, just without the "≈ " prefix and with thousands-grouping
  // (core's formatDisplayMoney/formatUsdDisplay parity).
  it("currency USD: ceil-to-0.01 matches formatUsdt's own rounding, no ≈ prefix", () => {
    expect(formatPriceFor("40000", "USD", "16000")).toBe("$2.50");
    expect(formatPriceFor("79000", "USD", "16000")).toBe("$4.94");
    expect(formatPriceFor("44500", "USD", "16000")).toBe("$2.79");
  });

  it("currency USD: groups thousands like core's formatUsdDisplay ($1,000.00, not $1000.00)", () => {
    expect(formatPriceFor("16000000", "USD", "16000")).toBe("$1,000.00");
  });

  // Rate unavailable while USD is requested: never a bare number, never a
  // "$" invented without a rate — falls back to the explicit Rp string,
  // same rule the bot follows (bot: currency.rate_unavailable).
  it("currency USD + fx null/invalid: falls back to the IDR string, never a bare/invented $", () => {
    expect(formatPriceFor("79000", "USD", null)).toBe("Rp79.000");
    expect(formatPriceFor("79000", "USD", "")).toBe("Rp79.000");
    expect(formatPriceFor("79000", "USD", "0")).toBe("Rp79.000");
    expect(formatPriceFor("79000", "USD", "-16000")).toBe("Rp79.000");
  });

  it("passes null/empty through to formatIdr's own em-dash, for any currency", () => {
    expect(formatPriceFor(null, "USD", "16000")).toBe("—");
    expect(formatPriceFor(undefined, "IDR", "16000")).toBe("—");
  });
});

describe("formatOrderAmount", () => {
  // An order's OWN settlement currency (order.currency, "IDR" | "USDT") —
  // never the viewer's display-currency preference. Task 5 bug fix: PayPage
  // and TicketOrderSummaryCard used to call formatIdr on these unconditionally.
  it('orderCurrency "USDT": renders the native USDT string, not an IDR-formatted number', () => {
    expect(formatOrderAmount("9.88", "USDT")).toBe("9.88 USDT");
  });

  it('orderCurrency "IDR" (or anything else): renders the Rp string, unaffected', () => {
    expect(formatOrderAmount("158000", "IDR")).toBe("Rp158.000");
    expect(formatOrderAmount("158000", null)).toBe("Rp158.000");
    expect(formatOrderAmount("158000", undefined)).toBe("Rp158.000");
  });
});
