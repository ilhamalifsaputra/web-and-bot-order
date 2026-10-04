import { describe, expect, it } from "vitest";
import { Decimal } from "./money";
import { denominationPriceError } from "./denominationPrices";

const d = (v: string) => new Decimal(v);

describe("denominationPriceError", () => {
  it("accepts a normal price with cost and reseller price", () => {
    expect(denominationPriceError({ price: d("10000"), costPrice: d("8000"), resellerPrice: d("9500") })).toBeNull();
  });

  it("accepts a price alone and a reseller price equal to the price", () => {
    expect(denominationPriceError({ price: d("4480.50") })).toBeNull();
    expect(denominationPriceError({ price: d("10000"), resellerPrice: d("10000") })).toBeNull();
  });

  it("accepts a zero cost price (goods with no purchase cost)", () => {
    expect(denominationPriceError({ price: d("10000"), costPrice: d("0") })).toBeNull();
  });

  it.each(["0", "-1", "0.5", "NaN", "Infinity"])("refuses a price of %s", (p) => {
    expect(denominationPriceError({ price: d(p) })).toMatch(/^Price/);
  });

  it.each(["0", "-5", "0.5", "NaN", "Infinity"])("refuses a reseller price of %s", (p) => {
    expect(denominationPriceError({ price: d("10000"), resellerPrice: d(p) })).toMatch(/^Reseller price/);
  });

  it.each(["-1", "NaN", "Infinity"])("refuses a cost price of %s", (p) => {
    expect(denominationPriceError({ price: d("10000"), costPrice: d(p) })).toMatch(/^Cost price/);
  });

  it("refuses a reseller price above the retail price", () => {
    expect(denominationPriceError({ price: d("10000"), resellerPrice: d("10000.01") })).toMatch(/Reseller price.*higher than the price/);
  });
});
