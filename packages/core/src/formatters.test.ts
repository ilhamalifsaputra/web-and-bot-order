import { describe, it, expect } from "vitest";
import { formatMoney, formatUsdt, formatUsdtAmount } from "./formatters";
import { Decimal } from "./money";

describe("formatMoney", () => {
  it("formats IDR with the Rp prefix and dotted thousands, no decimals", () => {
    expect(formatMoney(54000, "IDR")).toBe("Rp54.000");
  });

  it("formats a non-IDR currency as a 2-decimal amount with the code suffix", () => {
    expect(formatMoney(3.426, "USDT")).toBe("3.43 USDT");
  });

  it("never collapses a small non-IDR amount into a misleading whole-Rupiah figure", () => {
    // This is the exact bug from the report: a 3.43 USDT total must never render as "Rp3".
    const result = formatMoney(3.43, "USDT");
    expect(result).not.toContain("Rp");
    expect(result).toBe("3.43 USDT");
  });

  it("supports a currency code not seen before without throwing", () => {
    expect(formatMoney(12.5, "BTC")).toBe("12.50 BTC");
  });
});

describe("formatUsdtAmount / formatUsdt", () => {
  it("rounds to max 4dp and strips trailing zeros", () => {
    expect(formatUsdtAmount(0)).toBe("0");
    expect(formatUsdtAmount(1)).toBe("1");
    expect(formatUsdtAmount(1.5)).toBe("1.5");
    expect(formatUsdtAmount(12.34)).toBe("12.34");
    expect(formatUsdtAmount(96.7)).toBe("96.7");
    expect(formatUsdtAmount(123.456789)).toBe("123.4568");
  });

  it("collapses a whole number to a bare integer, no trailing decimal point", () => {
    expect(formatUsdtAmount("20.0000")).toBe("20");
  });

  it("rounds a sub-0.0001 amount to zero without leaking a negative sign", () => {
    expect(formatUsdtAmount(0.00001)).toBe("0");
    expect(formatUsdtAmount(-0.00001)).toBe("0");
  });

  it("rounds half-up at the 4th decimal boundary", () => {
    expect(formatUsdtAmount(0.00005)).toBe("0.0001");
  });

  it("keeps the sign for a negative amount", () => {
    expect(formatUsdtAmount(-5.2)).toBe("-5.2");
  });

  it("accepts a Decimal instance directly", () => {
    expect(formatUsdtAmount(new Decimal("12.3400"))).toBe("12.34");
  });

  it("formatUsdt appends the ' USDT' suffix", () => {
    expect(formatUsdt(0)).toBe("0 USDT");
    expect(formatUsdt(123.456789)).toBe("123.4568 USDT");
  });
});
