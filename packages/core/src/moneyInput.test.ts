import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeMoneyInput } from "./moneyInput";

// The full shape table (accepted and refused spellings) is pinned through
// `parseMoneyInput` in moneyFormat.test.ts, which wraps this function. These
// cases pin what only this layer promises: the exact canonical STRING, which
// the storefront posts to a server that accepts nothing but `digits[.digits]`.
describe("normalizeMoneyInput", () => {
  const CASES: Array<[string, "IDR" | "USDT", string | null]> = [
    ["79000", "IDR", "79000"],
    ["10.000", "IDR", "10000"],
    ["10,000", "IDR", "10000"],
    ["1.000.000", "IDR", "1000000"],
    ["10000,50", "IDR", "10000.5"],
    ["10000.5", "IDR", "10000.5"],
    ["1.000.000,50", "IDR", "1000000.5"],
    ["  25000  ", "IDR", "25000"],
    ["0", "IDR", "0"],
    ["007", "IDR", "7"],
    ["5,5", "USDT", "5.5"],
    ["5.07", "USDT", "5.07"],
    ["1.0000", "USDT", "1"],
    ["0.12345678", "USDT", "0.12345678"],
    ["1,000,000.50", "USDT", "1000000.5"],
    ["1.000", "USDT", null],
    ["1,000", "USDT", null],
    ["", "IDR", null],
    ["Rp10.000", "IDR", null],
    ["-5", "USDT", null],
    ["1e5", "IDR", null],
  ];

  it.each(CASES)("%j (%s) -> %j", (typed, currency, expected) => {
    expect(normalizeMoneyInput(typed, currency)).toBe(expected);
  });

  it("never returns exponent form, whatever the size", () => {
    expect(normalizeMoneyInput("12345678901234567890", "IDR")).toBe("12345678901234567890");
    expect(normalizeMoneyInput("0.00000001", "USDT")).toBe("0.00000001");
  });

  it("only ever returns the plain digits[.digits] shape the top-up API accepts", () => {
    for (const [typed, currency, expected] of CASES) {
      if (expected === null) continue;
      expect(normalizeMoneyInput(typed, currency)).toMatch(/^\d+(\.\d+)?$/);
    }
  });

  it("keeps the storefront client's copy byte-identical (it cannot import @app/core)", () => {
    const here = readFileSync(new URL("./moneyInput.ts", import.meta.url), "utf8");
    const copy = readFileSync(new URL("../../../apps/storefront/client/src/lib/moneyInput.ts", import.meta.url), "utf8");
    expect(copy, "apps/storefront/client/src/lib/moneyInput.ts must be an exact copy of packages/core/src/moneyInput.ts").toBe(here);
  });
});
