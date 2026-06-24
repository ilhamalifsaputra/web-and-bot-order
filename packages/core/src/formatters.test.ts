import { describe, it, expect } from "vitest";
import { formatMoney } from "./formatters";

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
