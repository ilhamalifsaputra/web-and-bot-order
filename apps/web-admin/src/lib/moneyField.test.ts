import { describe, expect, it } from "vitest";
import { readMoneyField, readPercentField, moneyFieldError } from "./moneyField";

describe("readMoneyField (IDR)", () => {
  it.each([
    ["10000", "10000"],
    ["10.000", "10000"],
    ["10,5", "10.5"],
    ["1.000.000", "1000000"],
    ["10000.50", "10000.5"],
    [" 2500 ", "2500"],
  ])("reads %j as %s", (raw, want) => {
    expect(readMoneyField(raw)?.toFixed()).toBe(want);
  });

  it.each(["abc", "", "NaN", "Infinity", "1e5", "-5", "1.2.3", "10.000,5.5", "Rp10.000"])("refuses %j", (raw) => {
    expect(readMoneyField(raw)).toBeNull();
  });

  it("takes a JSON number at its exact value, never re-reading its digits as grouping", () => {
    expect(readMoneyField(1.5)?.toFixed()).toBe("1.5");
    expect(readMoneyField(25000)?.toFixed()).toBe("25000");
    expect(readMoneyField(Number.NaN)).toBeNull();
    expect(readMoneyField(Number.POSITIVE_INFINITY)).toBeNull();
    expect(readMoneyField(-5)).toBeNull();
  });

  it("refuses non-string, non-number values", () => {
    expect(readMoneyField(null)).toBeNull();
    expect(readMoneyField(undefined)).toBeNull();
    expect(readMoneyField({})).toBeNull();
  });
});

describe("readMoneyField (signed)", () => {
  it.each([
    ["-10.000", "-10000"],
    ["+5000", "5000"],
    ["−5.000", "-5000"],
    ["- 2500", "-2500"],
    ["7500", "7500"],
  ])("reads %j as %s", (raw, want) => {
    expect(readMoneyField(raw, "IDR", { signed: true })?.toFixed()).toBe(want);
  });

  it("accepts a negative JSON number only when signed", () => {
    expect(readMoneyField(-5, "IDR", { signed: true })?.toFixed()).toBe("-5");
  });

  it("refuses a double sign", () => {
    expect(readMoneyField("--5", "IDR", { signed: true })).toBeNull();
  });
});

describe("readMoneyField (USDT)", () => {
  it("refuses an ambiguous single separator before three digits", () => {
    expect(readMoneyField("1.000", "USDT")).toBeNull();
    expect(readMoneyField("5.07", "USDT")?.toFixed()).toBe("5.07");
  });
});

describe("readPercentField", () => {
  it("reads typed and numeric percents", () => {
    expect(readPercentField("12,5")?.toFixed()).toBe("12.5");
    expect(readPercentField("10")?.toFixed()).toBe("10");
    expect(readPercentField(15)?.toFixed()).toBe("15");
  });

  it.each(["10.000", "abc", "", "-5", "NaN"])("refuses %j", (raw) => {
    expect(readPercentField(raw)).toBeNull();
  });
});

describe("moneyFieldError", () => {
  it("names the field and shows accepted spellings", () => {
    expect(moneyFieldError("Min purchase")).toMatch(/^Min purchase must be an amount/);
    expect(moneyFieldError("Min purchase")).toContain("10.000");
    expect(moneyFieldError("Gross amount", "USDT")).toContain("ambiguous");
  });
});
