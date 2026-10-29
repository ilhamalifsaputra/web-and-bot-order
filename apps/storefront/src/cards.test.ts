/**
 * shapeProducts' flash-sale shaping. The card shows ONE headline price with a
 * struck-through original beside it, so `from_price`, `flash_discount` and
 * `from_base_price` must always describe the SAME denomination — otherwise the
 * card advertises an original price no plan was ever sold at.
 */
import { describe, it, expect } from "vitest";
import { aggregateRating, isOutOfStock, parseSortKey, rankCards, shapeFlashCards, shapeProducts, type ProductCard } from "./cards";
import type { BestsellerSnapshot, CatalogProduct } from "@app/db";

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

describe("shapeProducts — volume tier badge", () => {
  type Tier = import("@app/core/bulk").PricingTier;
  const tier = (minQuantity: number, discountType: Tier["discountType"], discountValue: string, isEnabled = true): Tier => ({
    id: `t-${minQuantity}-${discountType}`,
    minQuantity,
    discountType,
    discountValue,
    isEnabled,
  });

  it("shows no badge when no plan has tiers", () => {
    const [card] = shapeProducts([productWith([denom()])], {}, new Map());
    expect(card!.bulk_discount).toBeNull();
    expect(card!.bulk_min_qty).toBeNull();
    expect(card!.bulk_up_to).toBe(false);
  });

  it("states a percent tier exactly, and picks the best tier across plans", () => {
    const a = denom({ price: "10000" });
    const b = denom({ price: "20000" });
    const [card] = shapeProducts(
      [productWith([a, b])],
      {},
      new Map(),
      { [a.id]: [tier(3, "PERCENTAGE", "10")], [b.id]: [tier(5, "PERCENTAGE", "12.5"), tier(2, "PERCENTAGE", "5")] },
    );
    expect(card!.bulk_discount).toBe("12.5");
    expect(card!.bulk_min_qty).toBe(5);
    expect(card!.bulk_up_to).toBe(false);
  });

  it("expresses a fixed-amount tier as a whole percent of the effective unit, rounded down, marked 'up to'", () => {
    // 3000 off a 7000 unit = 42.86% → 42, never 43.
    const d = denom({ price: "7000" });
    const [card] = shapeProducts([productWith([d])], {}, new Map(), { [d.id]: [tier(4, "FIXED_AMOUNT_OFF_PER_UNIT", "3000")] });
    expect(card!.bulk_discount).toBe("42");
    expect(card!.bulk_min_qty).toBe(4);
    expect(card!.bulk_up_to).toBe(true);
  });

  it("prices a fixed unit price against the viewer's own effective unit (reseller)", () => {
    // Everyone pays 10000 → a 6000 fixed price is 40% off. A reseller already
    // pays 8000 → the same tier is 25% off for them.
    const d = denom({ price: "10000", resellerPrice: "8000" });
    const tiers = { [d.id]: [tier(5, "FIXED_UNIT_PRICE", "6000")] };
    expect(shapeProducts([productWith([d])], {}, new Map(), tiers)[0]!.bulk_discount).toBe("40");
    expect(shapeProducts([productWith([d])], {}, new Map(), tiers, true)[0]!.bulk_discount).toBe("25");
  });

  it("never advertises a fixed price that would not lower the price, nor a disabled tier", () => {
    const d = denom({ price: "5000" });
    const [card] = shapeProducts([productWith([d])], {}, new Map(), {
      [d.id]: [tier(3, "FIXED_UNIT_PRICE", "6000"), tier(6, "PERCENTAGE", "50", false)],
    });
    expect(card!.bulk_discount).toBeNull();
    expect(card!.bulk_up_to).toBe(false);
  });
});

const DAY = 24 * HOUR;

let nextProductId = 100;
const product = (over: Record<string, unknown> = {}, denominations: CatalogProduct["denominations"] = [denom()]) => {
  const id = nextProductId++;
  return {
    id,
    slug: `p-${id}`,
    name: `Product ${id}`,
    webImageUrl: null,
    createdAt: new Date(Date.now() - 30 * DAY),
    category: { name: "Streaming" },
    denominations,
    ...over,
  } as unknown as CatalogProduct;
};

const snapshot = (recent: Array<[number, number]>, allTime: Array<[number, number]> = []): BestsellerSnapshot => ({
  version: 7,
  computedAt: new Date(),
  recent: new Map(recent),
  allTime: new Map(allTime),
});

describe("parseSortKey", () => {
  it("accepts the three sort keys", () => {
    expect(parseSortKey("bestseller", { allowCheapest: true })).toBe("bestseller");
    expect(parseSortKey("newest", { allowCheapest: true })).toBe("newest");
    expect(parseSortKey("cheapest", { allowCheapest: true })).toBe("cheapest");
  });

  it("falls back to bestseller for legacy, unknown and missing keys", () => {
    for (const raw of ["default", "rating", "bogus", "", undefined, null, 3, ["newest"]]) {
      expect(parseSortKey(raw, { allowCheapest: true })).toBe("bestseller");
    }
  });

  it("rejects cheapest where the page does not offer it", () => {
    expect(parseSortKey("cheapest", { allowCheapest: false })).toBe("bestseller");
    expect(parseSortKey("newest", { allowCheapest: false })).toBe("newest");
  });
});

describe("shapeProducts — new badge and promo fields", () => {
  it("marks a product created within the last 14 days as new, and an older one not", () => {
    const now = new Date();
    const cards = shapeProducts(
      [product({ createdAt: new Date(now.getTime() - 13 * DAY) }), product({ createdAt: new Date(now.getTime() - 15 * DAY) })],
      {},
      new Map(),
      {},
      false,
      now,
    );
    expect(cards.map((c) => c.is_new)).toEqual([true, false]);
  });

  it("gives a regular grid card empty promo fields", () => {
    const [card] = shapeProducts([product()], {}, new Map());
    expect(card).toMatchObject({ promo_denomination_id: null, promo_denomination_name: null, other_promo_count: 0 });
  });
});

describe("shapeFlashCards", () => {
  const now = new Date();
  const window = (endsInHours: number) => ({
    flashStartsAt: new Date(now.getTime() - HOUR),
    flashEndsAt: new Date(now.getTime() + endsInHours * HOUR),
  });

  it("represents the denomination with the largest flash percent, even when it is not the cheapest plan", () => {
    const cheap = denom({ name: "1 Week", price: "10000" });
    const small = denom({ name: "1 Month", price: "30000", flashDiscountPercent: "10", ...window(2) });
    const big = denom({ name: "1 Year", price: "200000", flashDiscountPercent: "40", ...window(5) });
    const [card] = shapeFlashCards([product({}, [cheap, small, big])], {}, new Map(), {}, now);
    expect(card).toMatchObject({
      from_price: "120000",
      from_base_price: "200000",
      flash_discount: "40",
      flash_ends_at: big.flashEndsAt!.toISOString(),
      promo_denomination_id: big.id,
      promo_denomination_name: "1 Year",
      other_promo_count: 1,
      variant_count: 3,
    });
  });

  it("breaks a percent tie by the sale ending soonest, then by the lowest id", () => {
    const later = denom({ price: "50000", flashDiscountPercent: "20", ...window(5) });
    const sooner = denom({ price: "60000", flashDiscountPercent: "20", ...window(1) });
    const [bySoonest] = shapeFlashCards([product({}, [later, sooner])], {}, new Map(), {}, now);
    expect(bySoonest!.promo_denomination_id).toBe(sooner.id);

    const sameEnd = window(3);
    const first = denom({ price: "50000", flashDiscountPercent: "20", ...sameEnd });
    const second = denom({ price: "40000", flashDiscountPercent: "20", ...sameEnd });
    const [byId] = shapeFlashCards([product({}, [second, first])], {}, new Map(), {}, now);
    expect(byId!.promo_denomination_id).toBe(first.id);
  });

  it("prices the promo plan for a non-reseller even when a reseller price is lower", () => {
    const d = denom({ price: "100000", resellerPrice: "50000", flashDiscountPercent: "10", ...window(2) });
    const [card] = shapeFlashCards([product({}, [d])], {}, new Map(), {}, now);
    expect(card!.from_price).toBe("90000");
  });

  it("skips products with no live flash sale", () => {
    const expired = denom({
      flashDiscountPercent: "20",
      flashStartsAt: new Date(now.getTime() - 2 * HOUR),
      flashEndsAt: new Date(now.getTime() - HOUR),
    });
    expect(shapeFlashCards([product(), product({}, [expired])], {}, new Map(), {}, now)).toEqual([]);
  });

  it("shares stock and rating aggregation with the grid card", () => {
    const d = denom({ price: "100000", flashDiscountPercent: "10", ...window(2) });
    const other = denom({ price: "5000" });
    const p = product({}, [d, other]);
    const stock = { [d.id]: { available: 3 }, [other.id]: { available: 4 } };
    const ratings = new Map([[other.id, { avg: 4, count: 2 }]]);
    const [flashCard] = shapeFlashCards([p], stock, ratings, {}, now);
    const [gridCard] = shapeProducts([p], stock, ratings, {}, false, now);
    expect(flashCard).toMatchObject({ available: gridCard!.available, rating: 4, rating_count: 2, image_kind: gridCard!.image_kind });
  });
});

describe("rankCards", () => {
  const card = (p: CatalogProduct, over: Partial<ProductCard> = {}): ProductCard =>
    ({ ...shapeProducts([p], {}, new Map())[0]!, ...over });

  it("orders by bestseller snapshot: recent, then all-time, then newest", () => {
    const old = product({ createdAt: new Date(Date.now() - 50 * DAY) });
    const young = product({ createdAt: new Date(Date.now() - 1 * DAY) });
    const hot = product({ createdAt: new Date(Date.now() - 60 * DAY) });
    const steady = product({ createdAt: new Date(Date.now() - 60 * DAY) });
    const products = [old, young, hot, steady];
    const ranked = rankCards(products, products.map((p) => card(p)), "bestseller", snapshot([[hot.id, 5]], [[steady.id, 9]]));
    expect(ranked.map((c) => c.slug)).toEqual([hot.slug, steady.slug, young.slug, old.slug]);
  });

  it("orders by newest createdAt", () => {
    const a = product({ createdAt: new Date(Date.now() - 3 * DAY) });
    const b = product({ createdAt: new Date(Date.now() - 1 * DAY) });
    const ranked = rankCards([a, b], [card(a), card(b)], "newest", snapshot([[a.id, 10]]));
    expect(ranked.map((c) => c.slug)).toEqual([b.slug, a.slug]);
  });

  it("orders by cheapest from_price as decimals, breaking ties by newest", () => {
    const nine = product();
    const ten = product();
    const tieOld = product({ createdAt: new Date(Date.now() - 9 * DAY) });
    const tieNew = product({ createdAt: new Date(Date.now() - 2 * DAY) });
    const ranked = rankCards(
      [ten, nine, tieOld, tieNew],
      [card(ten, { from_price: "10000" }), card(nine, { from_price: "9000" }), card(tieOld, { from_price: "9500" }), card(tieNew, { from_price: "9500" })],
      "cheapest",
      snapshot([]),
    );
    expect(ranked.map((c) => c.slug)).toEqual([nine.slug, tieNew.slug, tieOld.slug, ten.slug]);
  });

  it("moves out-of-stock local-inventory products to the back, keeping their relative order", () => {
    const soldOutHot = product();
    const soldOutWarm = product();
    const inStock = product();
    const provider = product();
    const products = [soldOutHot, soldOutWarm, inStock, provider];
    const cards = [
      card(soldOutHot, { all_local_inventory: true, available: 0 }),
      card(soldOutWarm, { all_local_inventory: true, available: 0 }),
      card(inStock, { all_local_inventory: true, available: 2 }),
      // Provider SKUs carry no stock count and are always purchasable.
      card(provider, { all_local_inventory: false, available: 0 }),
    ];
    const ranked = rankCards(products, cards, "bestseller", snapshot([[soldOutHot.id, 9], [soldOutWarm.id, 8], [inStock.id, 1]]));
    expect(ranked.map((c) => c.slug)).toEqual([inStock.slug, provider.slug, soldOutHot.slug, soldOutWarm.slug]);
    expect(ranked.map(isOutOfStock)).toEqual([false, false, true, true]);
  });
});
