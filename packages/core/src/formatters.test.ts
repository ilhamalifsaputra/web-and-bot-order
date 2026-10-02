import { describe, it, expect } from "vitest";
import {
  formatMoney,
  formatUsdt,
  formatUsdtAmount,
  formatUsdtBalance,
  usdtFromIdr,
  convertIdrToDisplay,
  formatDisplayMoney,
  formatDisplayMoneyResult,
} from "./formatters";
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

describe("formatUsdtBalance", () => {
  // A balance is read, not copied into a transfer, so it must never show exactly three decimals: a reader who
  // groups thousands with "." would take "12.345" for twelve thousand.
  it("pads a three-decimal fraction to four so it cannot be read as a thousands group", () => {
    expect(formatUsdtBalance("12.345")).toBe("12.3450");
    expect(formatUsdtBalance("0.125")).toBe("0.1250");
    expect(formatUsdtBalance("-7.005")).toBe("-7.0050");
    expect(formatUsdtBalance("12.34567")).toBe("12.3457");
  });

  it("is otherwise exactly formatUsdtAmount", () => {
    for (const v of ["0", "1", "1.5", "12.34", "96.7", "20.0000", "123.4568", "0.00001", "1000"]) {
      expect(formatUsdtBalance(v)).toBe(formatUsdtAmount(v));
    }
  });

  it("keeps the payable formatter unchanged", () => {
    expect(formatUsdtAmount("12.345")).toBe("12.345");
  });
});

describe("convertIdrToDisplay", () => {
  it("IDR display returns the IDR amount unchanged, no rate needed", () => {
    const r = convertIdrToDisplay("79000", "IDR", null);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.currency).toBe("IDR");
    expect(r.amount.equals(new Decimal("79000"))).toBe(true);
  });

  it("USD display equals usdtFromIdr exactly (the amount the USDT rails charge)", () => {
    for (const idr of ["79000", "44500", "40000", "15999", "16001", "1"]) {
      const r = convertIdrToDisplay(idr, "USD", "16000");
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("unreachable");
      expect(r.currency).toBe("USD");
      expect(r.amount.equals(usdtFromIdr(idr, "16000"))).toBe(true);
    }
  });

  it("rounds UP to the next cent at the boundary (ceil, never undercharges)", () => {
    const below = convertIdrToDisplay("15999", "USD", "16000");
    const exact = convertIdrToDisplay("16000", "USD", "16000");
    const above = convertIdrToDisplay("16001", "USD", "16000");
    if (!below.ok || !exact.ok || !above.ok) throw new Error("unreachable");
    expect(below.amount.toFixed(2)).toBe("1.00"); // 0.99993… → 1.00
    expect(exact.amount.toFixed(2)).toBe("1.00");
    expect(above.amount.toFixed(2)).toBe("1.01"); // 1.0000625 → 1.01
  });

  it("returns rate_unavailable for USD when the rate is missing, zero, negative or non-finite", () => {
    const badRates: Array<Decimal.Value | null | undefined> = [null, undefined, 0, "0", -16000, "-1", Infinity, NaN];
    for (const fx of badRates) {
      expect(convertIdrToDisplay("79000", "USD", fx)).toEqual({ ok: false, reason: "rate_unavailable" });
    }
  });

  it("stays in Decimal — no float drift on 0.1+0.2-prone amounts", () => {
    const r = convertIdrToDisplay("0.3", "IDR", null);
    if (!r.ok) throw new Error("unreachable");
    expect(r.amount.equals(new Decimal("0.1").plus("0.2"))).toBe(true);
    const u = convertIdrToDisplay("48000.3", "USD", "16000.1");
    if (!u.ok) throw new Error("unreachable");
    expect(u.amount.equals(usdtFromIdr("48000.3", "16000.1"))).toBe(true);
    expect(u.amount.toFixed(2)).toBe("3.00");
  });
});

describe("formatDisplayMoney / formatDisplayMoneyResult", () => {
  it("IDR renders exactly like formatIdr", () => {
    expect(formatDisplayMoney("79000", "IDR", "16000")).toBe("Rp79.000");
    expect(formatDisplayMoney("79000", "IDR", null)).toBe("Rp79.000");
  });

  it("USD renders as $ with 2dp", () => {
    expect(formatDisplayMoney("79000", "USD", "16000")).toBe("$4.94");
    expect(formatDisplayMoney("40000", "USD", "16000")).toBe("$2.50");
  });

  it("USD groups thousands with commas", () => {
    expect(formatDisplayMoney("20000000", "USD", "16000")).toBe("$1,250.00");
    expect(formatDisplayMoney("20000000000", "USD", "16000")).toBe("$1,250,000.00");
  });

  it("falls back to an explicit Rp string when the USD rate is unavailable — never a bare number or $", () => {
    const badRates: Array<Decimal.Value | null | undefined> = [null, undefined, 0, -5];
    for (const fx of badRates) {
      expect(formatDisplayMoneyResult("79000", "USD", fx)).toEqual({ text: "Rp79.000", currency: "IDR", fellBack: true });
      expect(formatDisplayMoney("79000", "USD", fx)).toBe("Rp79.000");
    }
  });

  it("reports no fallback when the requested currency was honoured", () => {
    expect(formatDisplayMoneyResult("79000", "USD", "16000")).toEqual({ text: "$4.94", currency: "USD", fellBack: false });
    expect(formatDisplayMoneyResult("79000", "IDR", null)).toEqual({ text: "Rp79.000", currency: "IDR", fellBack: false });
  });
});
