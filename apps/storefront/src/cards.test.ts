/**
 * shapeProducts' flash-sale shaping. The card shows ONE headline price with a
 * struck-through original beside it, so `from_price`, `flash_discount` and
 * `from_base_price` must always describe the SAME denomination — otherwise the
 * card advertises an original price no plan was ever sold at.
 */
import { describe, it, expect } from "vitest";
import { shapeProducts } from "./cards";
import type { CatalogProduct } from "@app/db";

const HOUR = 3_600_000;
const live = { flashStartsAt: new Date(Date.now() - HOUR), flashEndsAt: new Date(Date.now() + HOUR) };

let nextId = 1;
const denom = (over: Record<string, unknown> = {}) =>
  ({
    id: nextId++,
    name: "plan",
    slug: `plan-${nextId}`,
    price: "100000",
    resellerPrice: null,
    deliveryType: "auto",
    isActive: true,
    flashDiscountPercent: null,
    flashStartsAt: null,
    flashEndsAt: null,
    ...over,
  }) as unknown as CatalogProduct["denominations"][number];

const productWith = (denominations: CatalogProduct["denominations"]) =>
  ({
    id: 1,
    slug: "netflix",
    name: "Netflix",
    webImageUrl: "https://example.test/a.png",
    createdAt: new Date(),
    category: { name: "Streaming" },
    denominations,
  }) as unknown as CatalogProduct;

describe("shapeProducts — flash sales", () => {
  it("carries no flash fields when nothing is on sale", () => {
    const [card] = shapeProducts([productWith([denom()])], {}, new Map());
    expect(card!.from_price).toBe("100000");
    expect(card!.flash_discount).toBeNull();
    expect(card!.from_base_price).toBeNull();
    expect(card!.flash_ends_at).toBeNull();
  });

  it("uses the sale price as the starting price and reports that plan's exact base price", () => {
    const [card] = shapeProducts(
      [productWith([denom({ price: "100000", flashDiscountPercent: "20", ...live })])],
      {},
      new Map(),
    );
    expect(card!.from_price).toBe("80000");
    expect(card!.flash_discount).toBe("20");
    expect(card!.from_base_price).toBe("100000");
  });

  it("lets a flash sale change which plan leads the card", () => {
    // The 50%-off 100k plan (=50k) undercuts the plan listed at 60k.
    const [card] = shapeProducts(
      [
        productWith([
          denom({ price: "60000" }),
          denom({ price: "100000", flashDiscountPercent: "50", ...live }),
        ]),
      ],
      {},
      new Map(),
    );
    expect(card!.from_price).toBe("50000");
    expect(card!.from_base_price).toBe("100000");
    expect(card!.flash_discount).toBe("50");
  });

  it("reports the discount of the plan behind from_price, NOT the biggest one on the product", () => {
    // The 90%-off plan is the deepest discount but still costs 90k — far more
    // than the plain 10k plan that actually sets from_price. Advertising "−90%"
    // next to Rp10.000 would imply a Rp100.000 original for a plan that never
    // cost that.
    const [card] = shapeProducts(
      [
        productWith([
          denom({ price: "10000" }),
          denom({ price: "900000", flashDiscountPercent: "90", ...live }),
        ]),
      ],
      {},
      new Map(),
    );
    expect(card!.from_price).toBe("10000");
    expect(card!.flash_discount).toBeNull();
    expect(card!.from_base_price).toBeNull();
  });

  it("ignores a flash window that has not opened or has already closed", () => {
    const [notYet] = shapeProducts(
      [
        productWith([
          denom({
            flashDiscountPercent: "20",
            flashStartsAt: new Date(Date.now() + HOUR),
            flashEndsAt: new Date(Date.now() + 2 * HOUR),
          }),
        ]),
      ],
      {},
      new Map(),
    );
    expect(notYet!.from_price).toBe("100000");
    expect(notYet!.flash_discount).toBeNull();

    const [over] = shapeProducts(
      [
        productWith([
          denom({
            flashDiscountPercent: "20",
            flashStartsAt: new Date(Date.now() - 2 * HOUR),
            flashEndsAt: new Date(Date.now() - HOUR),
          }),
        ]),
      ],
      {},
      new Map(),
    );
    expect(over!.from_price).toBe("100000");
    expect(over!.flash_discount).toBeNull();
  });
});
