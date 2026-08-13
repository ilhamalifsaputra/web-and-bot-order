/**
 * shapeProducts' flash-sale shaping. The card shows ONE headline price with a
 * struck-through original beside it, so `from_price`, `flash_discount` and
 * `from_base_price` must always describe the SAME denomination — otherwise the
 * card advertises an original price no plan was ever sold at.
 */
import { describe, it, expect } from "vitest";
import { aggregateRating, shapeProducts } from "./cards";
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

// aggregateRating is the single weighted-average implementation shared by
// shapeProducts (grid/related-product cards) and productPageData (the
// product detail page's own aggregate, apps/storefront/src/pageData.ts) —
// this locks its contract down directly so the two callers can't quietly
// diverge.
describe("aggregateRating", () => {
  it("count-weights the average across denominations rather than treating each plan equally", () => {
    // Plan A: 5.0 avg over 8 reviews. Plan B: 1.0 avg over 2 reviews.
    // A simple (unweighted) mean of the two averages would be 3.0; the
    // count-weighted true average is (5*8 + 1*2) / 10 = 4.2.
    const ratings = new Map([
      [1, { avg: 5.0, count: 8 }],
      [2, { avg: 1.0, count: 2 }],
    ]);
    const result = aggregateRating([1, 2], ratings);
    expect(result.count).toBe(10);
    expect(result.avg).toBeCloseTo(4.2);
  });

  it("returns null avg and zero count when no denomination has any reviews", () => {
    const result = aggregateRating([1, 2], new Map());
    expect(result.avg).toBeNull();
    expect(result.count).toBe(0);
  });

  it("skips a denomination with a zero count even if present in the map", () => {
    const ratings = new Map([
      [1, { avg: 4.0, count: 3 }],
      [2, { avg: null, count: 0 }],
    ]);
    const result = aggregateRating([1, 2], ratings);
    expect(result.count).toBe(3);
    expect(result.avg).toBeCloseTo(4.0);
  });

  it("ignores denomination ids absent from the ratings map (no reviews at all)", () => {
    const ratings = new Map([[1, { avg: 4.0, count: 3 }]]);
    const result = aggregateRating([1, 999], ratings);
    expect(result.count).toBe(3);
    expect(result.avg).toBeCloseTo(4.0);
  });
});

describe("shapeProducts — rating aggregation reuses aggregateRating", () => {
  it("combines every denomination's rating summary, not just the cheapest plan's", () => {
    const cheap = denom({ price: "10000" });
    const pricey = denom({ price: "50000" });
    const ratings = new Map([
      [cheap.id, { avg: 5.0, count: 1 }],
      [pricey.id, { avg: 3.0, count: 3 }],
    ]);
    const [card] = shapeProducts([productWith([cheap, pricey])], {}, ratings);
    // (5*1 + 3*3) / 4 = 3.5 — the cheapest plan's 5.0 alone would be wrong.
    expect(card!.rating).toBeCloseTo(3.5);
    expect(card!.rating_count).toBe(4);
  });
});
