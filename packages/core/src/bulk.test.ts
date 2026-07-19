/**
 * Bulk-rule validation at READ time — the guard that makes a stored row safe to
 * price with (mirrors flash.test.ts, which pins the same contract for flash
 * sales). upsertBulkPricing rejects a bad rule at write time; these tests pin
 * what happens when a bad rule is already in the table anyway (written before
 * that guard existed, or by hand against the shared SQLite file).
 */
import { describe, it, expect } from "vitest";
import { activeBulkPercent, isBulkActive, bulkDiscountFor } from "./bulk";

const rule = (over: Partial<{ minQuantity: number; discountPercent: string }> = {}) => ({
  minQuantity: 5,
  discountPercent: "20",
  ...over,
});

describe("activeBulkPercent", () => {
  it("applies from the threshold up, not below it", () => {
    expect(activeBulkPercent(rule(), 4)).toBeNull();
    expect(activeBulkPercent(rule(), 5)!.toString()).toBe("20");
    expect(activeBulkPercent(rule(), 50)!.toString()).toBe("20");
  });

  it("returns null for a missing rule", () => {
    expect(activeBulkPercent(null, 10)).toBeNull();
    expect(activeBulkPercent(undefined, 10)).toBeNull();
  });

  it("REFUSES a stored percent outside (0,100] — a free order is one bad row away", () => {
    expect(activeBulkPercent(rule({ discountPercent: "0" }), 10)).toBeNull();
    expect(activeBulkPercent(rule({ discountPercent: "-5" }), 10)).toBeNull();
    expect(activeBulkPercent(rule({ discountPercent: "101" }), 10)).toBeNull();
    expect(activeBulkPercent(rule({ discountPercent: "not-a-number" }), 10)).toBeNull();
    // 100% is a giveaway an admin can legitimately configure, so it stands.
    expect(activeBulkPercent(rule({ discountPercent: "100" }), 10)!.toString()).toBe("100");
  });

  it("REFUSES a threshold below 1 — it would discount every single-unit order", () => {
    expect(activeBulkPercent(rule({ minQuantity: 0 }), 1)).toBeNull();
    expect(activeBulkPercent(rule({ minQuantity: -3 }), 1)).toBeNull();
    expect(activeBulkPercent(rule({ minQuantity: 2.5 }), 10)).toBeNull();
  });

  it("isBulkActive mirrors it as a boolean", () => {
    expect(isBulkActive(rule(), 5)).toBe(true);
    expect(isBulkActive(rule(), 4)).toBe(false);
  });
});

describe("bulkDiscountFor", () => {
  it("returns the amount to subtract, quantized to 4dp", () => {
    expect(bulkDiscountFor("80000", rule({ discountPercent: "25" }), 5).toString()).toBe("20000");
    expect(bulkDiscountFor("10001", rule({ discountPercent: "33" }), 5).toString()).toBe("3300.33");
  });

  it("is zero whenever the rule doesn't apply", () => {
    expect(bulkDiscountFor("80000", rule(), 4).toString()).toBe("0");
    expect(bulkDiscountFor("80000", null, 99).toString()).toBe("0");
    expect(bulkDiscountFor("80000", rule({ discountPercent: "150" }), 10).toString()).toBe("0");
  });

  it("never exceeds the line subtotal, so a discounted line can't go negative", () => {
    const full = bulkDiscountFor("40000", rule({ discountPercent: "100" }), 5);
    expect(full.toString()).toBe("40000");
  });
});
