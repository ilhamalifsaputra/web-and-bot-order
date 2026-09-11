import { describe, it, expect } from "vitest";
import { formatCompactQty, formatCompactPrice } from "./compactFormat";
import { formatIdr } from "./formatters";
import { Decimal } from "./money";

describe("formatCompactQty", () => {
  it("formats values under 1000 as-is", () => {
    expect(formatCompactQty(100)).toBe("100");
    expect(formatCompactQty(500)).toBe("500");
    expect(formatCompactQty(630)).toBe("630");
    expect(formatCompactQty(310)).toBe("310");
  });

  it("formats values 1000..999999 as K with up to 2 decimals, trailing zeros trimmed", () => {
    expect(formatCompactQty(1000)).toBe("1K");
    expect(formatCompactQty(2500)).toBe("2.5K");
    expect(formatCompactQty(1580)).toBe("1.58K");
    expect(formatCompactQty(5000)).toBe("5K");
    expect(formatCompactQty(10000)).toBe("10K");
  });

  it("formats values >= 1000000 as M with up to 2 decimals, trailing zeros trimmed", () => {
    expect(formatCompactQty(1000000)).toBe("1M");
  });
});

describe("formatCompactPrice", () => {
  it("formats amounts under 1000 via formatIdr", () => {
    const expectedFor500 = formatIdr(500);
    expect(formatCompactPrice(500)).toBe(expectedFor500);
  });

  it("formats amounts 1000..999999 as K rounded to nearest whole number", () => {
    expect(formatCompactPrice(354728)).toBe("Rp355K");
    expect(formatCompactPrice(411934)).toBe("Rp412K");
    expect(formatCompactPrice(166793)).toBe("Rp167K");
    expect(formatCompactPrice(70928)).toBe("Rp71K");
    expect(formatCompactPrice(141944)).toBe("Rp142K");
  });

  it("formats amounts >= 1000000 as M with up to 2 decimals, trailing zeros trimmed", () => {
    expect(formatCompactPrice(1644930)).toBe("Rp1.64M");
  });

  it("accepts Decimal values directly", () => {
    expect(formatCompactPrice(new Decimal(354728))).toBe("Rp355K");
    expect(formatCompactPrice(new Decimal(1644930))).toBe("Rp1.64M");
  });
});
