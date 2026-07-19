import { describe, it, expect } from "vitest";
import { activeFlashPercent, isFlashActive, flashPrice, effectiveUnitPrice } from "./flash";
import { Decimal } from "./money";

const START = new Date("2026-07-20T10:00:00Z");
const END = new Date("2026-07-20T22:00:00Z");
const DURING = new Date("2026-07-20T15:00:00Z");

/** A 20%-off flash sale on a Rp10.000 SKU, no reseller price unless given. */
const sku = (over: Partial<Parameters<typeof effectiveUnitPrice>[0]> = {}) => ({
  price: "10000",
  resellerPrice: null,
  flashDiscountPercent: "20",
  flashStartsAt: START,
  flashEndsAt: END,
  ...over,
});

describe("activeFlashPercent", () => {
  it("is null before the window opens and after it closes", () => {
    expect(activeFlashPercent(sku(), new Date("2026-07-20T09:59:59Z"))).toBeNull();
    expect(activeFlashPercent(sku(), new Date("2026-07-20T22:00:01Z"))).toBeNull();
  });

  it("treats the window as half-open — live at the start instant, over at the end instant", () => {
    expect(activeFlashPercent(sku(), START)?.toString()).toBe("20");
    expect(activeFlashPercent(sku(), END)).toBeNull();
  });

  it("is null unless all three columns are set", () => {
    expect(activeFlashPercent(sku({ flashDiscountPercent: null }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashStartsAt: null }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashEndsAt: null }), DURING)).toBeNull();
  });

  it("rejects a percent outside (0,100] so a bad row can never zero out a price", () => {
    expect(activeFlashPercent(sku({ flashDiscountPercent: "0" }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashDiscountPercent: "-5" }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashDiscountPercent: "100.01" }), DURING)).toBeNull();
    expect(activeFlashPercent(sku({ flashDiscountPercent: "not a number" }), DURING)).toBeNull();
    // 100% off is a legitimate giveaway, so it stays allowed.
    expect(activeFlashPercent(sku({ flashDiscountPercent: "100" }), DURING)?.toString()).toBe("100");
  });

  it("isFlashActive mirrors it as a boolean", () => {
    expect(isFlashActive(sku(), DURING)).toBe(true);
    expect(isFlashActive(sku(), END)).toBe(false);
  });
});

describe("flashPrice", () => {
  it("applies the percent to the base price, rounded to 2 decimals", () => {
    expect(flashPrice(sku(), DURING)!.toString()).toBe("8000");
    expect(flashPrice(sku({ flashDiscountPercent: "33" }), DURING)!.toString()).toBe("6700");
    expect(flashPrice(sku({ price: "10001", flashDiscountPercent: "33" }), DURING)!.toString()).toBe("6700.67");
  });

  it("ignores resellerPrice — it is the everyone price the UI strikes through", () => {
    expect(flashPrice(sku({ resellerPrice: "5000" }), DURING)!.toString()).toBe("8000");
  });

  it("is null with no live sale", () => {
    expect(flashPrice(sku(), END)).toBeNull();
  });
});

describe("effectiveUnitPrice", () => {
  it("without a flash sale, behaves exactly like the old inline rule", () => {
    const plain = sku({ flashDiscountPercent: null, resellerPrice: "7000" });
    expect(effectiveUnitPrice(plain, false, DURING).toString()).toBe("10000");
    expect(effectiveUnitPrice(plain, true, DURING).toString()).toBe("7000");
    expect(effectiveUnitPrice({ ...plain, resellerPrice: null }, true, DURING).toString()).toBe("10000");
  });

  it("charges a regular buyer the flash price while the sale runs", () => {
    expect(effectiveUnitPrice(sku(), false, DURING).toString()).toBe("8000");
    expect(effectiveUnitPrice(sku(), false, END).toString()).toBe("10000");
  });

  it("gives a reseller whichever of resellerPrice and the flash price is cheaper", () => {
    // Reseller price already beats the sale — keep it.
    expect(effectiveUnitPrice(sku({ resellerPrice: "7000" }), true, DURING).toString()).toBe("7000");
    // The sale beats the reseller price — the reseller gets the sale.
    expect(effectiveUnitPrice(sku({ resellerPrice: "9000" }), true, DURING).toString()).toBe("8000");
  });

  it("never compounds the two discounts", () => {
    const price = effectiveUnitPrice(sku({ resellerPrice: "9000" }), true, DURING);
    expect(price.greaterThanOrEqualTo(new Decimal("8000"))).toBe(true);
  });
});
