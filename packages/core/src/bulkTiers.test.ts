/**
 * The tiered pricing engine (bulk.ts): resolveTieredPrice, validateTiers,
 * tiersFromLegacyRule and analyzeTiers. The legacy single-rule helpers keep
 * their own contract in bulk.test.ts; the equivalence block below proves the
 * engine reproduces them to the rupiah.
 */
import { describe, it, expect } from "vitest";
import { Decimal } from "./money";
import {
  analyzeTiers,
  bulkDiscountFor,
  resolveTieredPrice,
  TieredPricingError,
  tiersFromLegacyRule,
  validateTiers,
  type PricingTier,
} from "./bulk";

const tier = (over: Partial<PricingTier> & Pick<PricingTier, "minQuantity">): PricingTier => ({
  id: `t${over.minQuantity}`,
  discountType: "PERCENTAGE",
  discountValue: "10",
  isEnabled: true,
  ...over,
});

const D = (v: Decimal.Value) => new Decimal(v);

// The spec example: base 10000, 3+ at 8000 each, 5+ at 6000 each.
const specTiers: PricingTier[] = [
  tier({ minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: "8000" }),
  tier({ minQuantity: 5, discountType: "FIXED_UNIT_PRICE", discountValue: "6000" }),
];

describe("resolveTieredPrice — spec example", () => {
  it("prices qty 1..6 as 10000, 20000, 24000, 32000, 30000, 36000", () => {
    const totals = [1, 2, 3, 4, 5, 6].map((q) =>
      resolveTieredPrice({ effectiveUnit: D(10000), quantity: q, tiers: specTiers }).finalSubtotal.toString(),
    );
    expect(totals).toEqual(["10000", "20000", "24000", "32000", "30000", "36000"]);
  });

  it("returns every breakdown field", () => {
    const r = resolveTieredPrice({ effectiveUnit: D(10000), quantity: 4, tiers: specTiers });
    expect(r.baseUnitPrice.toString()).toBe("10000");
    expect(r.quantity).toBe(4);
    expect(r.appliedTier?.id).toBe("t3");
    expect(r.originalSubtotal.toString()).toBe("40000");
    expect(r.discountPerUnit.toString()).toBe("2000");
    expect(r.totalDiscount.toString()).toBe("8000");
    expect(r.finalSubtotal.toString()).toBe("32000");
    expect(r.finalUnitPrice.toString()).toBe("8000");
    expect(r.currency).toBe("IDR");
  });

  it("applies no tier below the lowest threshold", () => {
    const r = resolveTieredPrice({ effectiveUnit: D(10000), quantity: 2, tiers: specTiers });
    expect(r.appliedTier).toBeNull();
    expect(r.totalDiscount.toString()).toBe("0");
    expect(r.discountPerUnit.toString()).toBe("0");
    expect(r.finalUnitPrice.toString()).toBe("10000");
  });

  it("matches thresholds exactly (minQuantity - 1 misses, minQuantity hits)", () => {
    const tiers = [tier({ minQuantity: 10, discountValue: "5" })];
    expect(resolveTieredPrice({ effectiveUnit: D(1000), quantity: 9, tiers }).appliedTier).toBeNull();
    expect(resolveTieredPrice({ effectiveUnit: D(1000), quantity: 10, tiers }).appliedTier?.id).toBe("t10");
  });

  it("is independent of input order", () => {
    const reversed = [...specTiers].reverse();
    for (const q of [1, 3, 4, 5, 9]) {
      const a = resolveTieredPrice({ effectiveUnit: D(10000), quantity: q, tiers: specTiers });
      const b = resolveTieredPrice({ effectiveUnit: D(10000), quantity: q, tiers: reversed });
      expect(b.finalSubtotal.toString()).toBe(a.finalSubtotal.toString());
      expect(b.appliedTier?.id ?? null).toBe(a.appliedTier?.id ?? null);
    }
  });
});

describe("resolveTieredPrice — discount types", () => {
  it("PERCENTAGE takes pct of the subtotal, rounded once to whole rupiah", () => {
    const tiers = [tier({ minQuantity: 5, discountValue: "30" })];
    const r = resolveTieredPrice({ effectiveUnit: D("14500"), quantity: 5, tiers });
    expect(r.originalSubtotal.toString()).toBe("72500");
    expect(r.totalDiscount.toString()).toBe("21750");
    expect(r.finalSubtotal.toString()).toBe("50750");
    expect(r.finalUnitPrice.toString()).toBe("10150");
  });

  it("PERCENTAGE with a repeating fraction (33.333%) rounds the total, not each unit", () => {
    const tiers = [tier({ minQuantity: 3, discountValue: "33.333" })];
    const r = resolveTieredPrice({ effectiveUnit: D("10001"), quantity: 3, tiers });
    // 30003 × 0.33333 = 10000.899... -> 10001
    expect(r.totalDiscount.toString()).toBe("10001");
    expect(r.finalSubtotal.toString()).toBe("20002");
    expect(r.finalUnitPrice.toString()).toBe("6667.3333");
    expect(r.discountPerUnit.toString()).toBe("3333.6667");
  });

  it("PERCENTAGE 100 is a full giveaway, never negative", () => {
    const r = resolveTieredPrice({
      effectiveUnit: D(8000),
      quantity: 5,
      tiers: [tier({ minQuantity: 5, discountValue: "100" })],
    });
    expect(r.finalSubtotal.toString()).toBe("0");
    expect(r.totalDiscount.toString()).toBe("40000");
  });

  it("FIXED_AMOUNT_OFF_PER_UNIT subtracts the amount from each unit", () => {
    const r = resolveTieredPrice({
      effectiveUnit: D(10000),
      quantity: 4,
      tiers: [tier({ minQuantity: 3, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "1500" })],
    });
    expect(r.discountPerUnit.toString()).toBe("1500");
    expect(r.totalDiscount.toString()).toBe("6000");
    expect(r.finalSubtotal.toString()).toBe("34000");
  });

  it("FIXED_AMOUNT_OFF_PER_UNIT larger than the unit is clamped to the unit (line goes to 0, not negative)", () => {
    const r = resolveTieredPrice({
      effectiveUnit: D(1000),
      quantity: 3,
      tiers: [tier({ minQuantity: 3, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "5000" })],
    });
    expect(r.discountPerUnit.toString()).toBe("1000");
    expect(r.totalDiscount.toString()).toBe("3000");
    expect(r.finalSubtotal.toString()).toBe("0");
  });

  it("FIXED_UNIT_PRICE above or equal to the effective unit is ignored (never raises the price)", () => {
    for (const value of ["12000", "10000"]) {
      const r = resolveTieredPrice({
        effectiveUnit: D(10000),
        quantity: 3,
        tiers: [tier({ minQuantity: 3, discountType: "FIXED_UNIT_PRICE", discountValue: value })],
      });
      expect(r.finalSubtotal.toString()).toBe("30000");
      expect(r.totalDiscount.toString()).toBe("0");
    }
  });

  it("FIXED_UNIT_PRICE stacks on a reseller/flash-reduced effective unit (only if still cheaper)", () => {
    const tiers = [tier({ minQuantity: 2, discountType: "FIXED_UNIT_PRICE", discountValue: "9000" })];
    expect(resolveTieredPrice({ effectiveUnit: D(9500), quantity: 2, tiers }).finalSubtotal.toString()).toBe("18000");
    expect(resolveTieredPrice({ effectiveUnit: D(8500), quantity: 2, tiers }).finalSubtotal.toString()).toBe("17000");
  });

  it("nominal tiers round the per-unit discount to whole rupiah for IDR", () => {
    const r = resolveTieredPrice({
      effectiveUnit: D(10000),
      quantity: 3,
      tiers: [tier({ minQuantity: 3, discountType: "FIXED_AMOUNT_OFF_PER_UNIT", discountValue: "999.5" })],
    });
    expect(r.discountPerUnit.toString()).toBe("1000");
    expect(r.totalDiscount.toString()).toBe("3000");
  });

  it("ignores disabled tiers", () => {
    const tiers = [
      tier({ minQuantity: 3, discountValue: "10" }),
      tier({ minQuantity: 5, discountValue: "50", isEnabled: false }),
    ];
    const r = resolveTieredPrice({ effectiveUnit: D(1000), quantity: 6, tiers });
    expect(r.appliedTier?.id).toBe("t3");
    expect(r.totalDiscount.toString()).toBe("600");
  });

  it("with no tiers, the line is just effectiveUnit × qty", () => {
    const r = resolveTieredPrice({ effectiveUnit: D(2500), quantity: 7, tiers: [] });
    expect(r.finalSubtotal.toString()).toBe("17500");
    expect(r.appliedTier).toBeNull();
  });
});

describe("resolveTieredPrice — refusals", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses quantity %s with a typed error", (q) => {
    expect(() => resolveTieredPrice({ effectiveUnit: D(1000), quantity: q, tiers: [] })).toThrow(TieredPricingError);
    try {
      resolveTieredPrice({ effectiveUnit: D(1000), quantity: q, tiers: [] });
    } catch (e) {
      expect((e as TieredPricingError).code).toBe("INVALID_QUANTITY");
    }
  });

  it("refuses an invalid effective unit", () => {
    expect(() => resolveTieredPrice({ effectiveUnit: D(-1), quantity: 1, tiers: [] })).toThrow(TieredPricingError);
  });

  it("refuses ambiguous tiers (duplicate minQuantity) even when the quantity is below both", () => {
    const tiers = [tier({ minQuantity: 5, id: "a" }), tier({ minQuantity: 5, id: "b", discountValue: "20" })];
    expect(() => resolveTieredPrice({ effectiveUnit: D(1000), quantity: 2, tiers })).toThrow(TieredPricingError);
    try {
      resolveTieredPrice({ effectiveUnit: D(1000), quantity: 6, tiers });
    } catch (e) {
      expect((e as TieredPricingError).code).toBe("INVALID_TIERS");
      expect((e as TieredPricingError).errors.some((x) => x.code === "DUPLICATE_MIN_QUANTITY")).toBe(true);
    }
  });

  it("refuses a tier with an invalid value", () => {
    expect(() =>
      resolveTieredPrice({ effectiveUnit: D(1000), quantity: 6, tiers: [tier({ minQuantity: 2, discountValue: "-5" })] }),
    ).toThrow(TieredPricingError);
  });
});

describe("validateTiers", () => {
  const codes = (tiers: PricingTier[]) => {
    const r = validateTiers(tiers);
    return r.ok ? [] : r.errors.map((e) => e.code);
  };

  it("accepts a valid set of any size (no hardcoded maximum)", () => {
    const many = Array.from({ length: 40 }, (_, i) => tier({ minQuantity: i + 2, discountValue: "1" }));
    expect(validateTiers(many)).toEqual({ ok: true });
    expect(validateTiers([])).toEqual({ ok: true });
  });

  it("rejects minQuantity that is not an integer >= 2 (qty 1 is the implicit base)", () => {
    expect(codes([tier({ minQuantity: 1 })])).toEqual(["INVALID_MIN_QUANTITY"]);
    expect(codes([tier({ minQuantity: 0 })])).toEqual(["INVALID_MIN_QUANTITY"]);
    expect(codes([tier({ minQuantity: 2.5 })])).toEqual(["INVALID_MIN_QUANTITY"]);
    expect(codes([tier({ minQuantity: Number.NaN })])).toEqual(["INVALID_MIN_QUANTITY"]);
  });

  it("rejects duplicate minQuantity among all tiers, disabled ones included", () => {
    expect(codes([tier({ minQuantity: 3, id: "a" }), tier({ minQuantity: 3, id: "b", isEnabled: false })])).toContain(
      "DUPLICATE_MIN_QUANTITY",
    );
  });

  it("rejects zero, negative, non-finite and unparsable values", () => {
    for (const v of ["0", "-1", "abc", Number.NaN, Number.POSITIVE_INFINITY, "Infinity"]) {
      expect(codes([tier({ minQuantity: 2, discountType: "FIXED_UNIT_PRICE", discountValue: v })])).toEqual([
        "INVALID_VALUE",
      ]);
    }
  });

  it("rejects a percentage outside (0, 100]", () => {
    expect(codes([tier({ minQuantity: 2, discountValue: "100.01" })])).toEqual(["INVALID_PERCENTAGE"]);
    expect(codes([tier({ minQuantity: 2, discountValue: "100" })])).toEqual([]);
  });

  it("rejects an unknown discount type", () => {
    expect(codes([tier({ minQuantity: 2, discountType: "BOGO" as never })])).toEqual(["UNKNOWN_TYPE"]);
  });

  it("names the offending tier", () => {
    const r = validateTiers([tier({ minQuantity: 2, id: "x", discountValue: "-1" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]!.tierId).toBe("x");
      expect(r.errors[0]!.message.length).toBeGreaterThan(0);
    }
  });
});

describe("tiersFromLegacyRule — engine reproduces bulkDiscountFor exactly", () => {
  it("converts a rule into one PERCENTAGE tier and nothing for no rule", () => {
    expect(tiersFromLegacyRule(null)).toEqual([]);
    const [t] = tiersFromLegacyRule({ minQuantity: 5, discountPercent: "12.5" });
    expect(t).toMatchObject({ id: "legacy", minQuantity: 5, discountType: "PERCENTAGE", isEnabled: true });
    expect(D(t!.discountValue).toString()).toBe("12.5");
  });

  it("drops a rule the legacy read-time guard refuses (it never discounted anything)", () => {
    expect(tiersFromLegacyRule({ minQuantity: 5, discountPercent: "150" })).toEqual([]);
    expect(tiersFromLegacyRule({ minQuantity: 0, discountPercent: "10" })).toEqual([]);
    expect(tiersFromLegacyRule({ minQuantity: 2.5, discountPercent: "10" })).toEqual([]);
    expect(tiersFromLegacyRule({ minQuantity: 5, discountPercent: "nope" })).toEqual([]);
  });

  it("does NOT convert a legacy minQuantity-1 rule (not representable: qty 1 is the base price)", () => {
    // Known divergence, pinned on purpose: bulkDiscountFor still honours such a
    // row; a caller routing through the engine must migrate it explicitly.
    expect(tiersFromLegacyRule({ minQuantity: 1, discountPercent: "10" })).toEqual([]);
    expect(bulkDiscountFor("1000", { minQuantity: 1, discountPercent: "10" }, 1).toString()).toBe("100");
  });

  it("matches bulkDiscountFor for many (unit, pct, qty, minQuantity) combos, .5 edges included", () => {
    const units = ["1", "3", "999", "4650", "9300", "10001", "14500", "46500", "123457", "99999"];
    const pcts = ["0.5", "1", "5", "12.5", "15", "20", "33", "33.333", "50", "66.67", "99.99", "100"];
    const qtys = [1, 2, 3, 4, 5, 7, 10, 11, 25, 99];
    const mins = [2, 3, 5, 10];
    let checked = 0;
    for (const u of units)
      for (const p of pcts)
        for (const q of qtys)
          for (const m of mins) {
            const rule = { minQuantity: m, discountPercent: p };
            const subtotal = D(u).times(q);
            const legacy = bulkDiscountFor(subtotal, rule, q);
            const r = resolveTieredPrice({ effectiveUnit: D(u), quantity: q, tiers: tiersFromLegacyRule(rule) });
            expect(r.totalDiscount.toString(), `${u}×${q} @${p}% min ${m}`).toBe(legacy.toString());
            expect(r.finalSubtotal.toString()).toBe(subtotal.minus(legacy).toString());
            checked++;
          }
    expect(checked).toBe(units.length * pcts.length * qtys.length * mins.length);
  });

  it("rounds an exact half up like the legacy formula (46500 × 12.5% = 5812.5 -> 5813)", () => {
    const r = resolveTieredPrice({
      effectiveUnit: D(9300),
      quantity: 5,
      tiers: tiersFromLegacyRule({ minQuantity: 5, discountPercent: "12.5" }),
    });
    expect(r.totalDiscount.toString()).toBe("5813");
  });
});

describe("analyzeTiers", () => {
  it("flags the spec example's qty 4 -> 5 drop (32000 -> 30000)", () => {
    const a = analyzeTiers({ effectiveUnit: D(10000), tiers: specTiers });
    expect(a.nonMonotonic).toEqual([
      { fromQuantity: 4, toQuantity: 5, fromTotal: D(32000), toTotal: D(30000) },
    ]);
  });

  it("reports nothing for a monotonic set", () => {
    const tiers = [tier({ minQuantity: 3, discountValue: "5" }), tier({ minQuantity: 10, discountValue: "10" })];
    expect(analyzeTiers({ effectiveUnit: D(10000), tiers })).toEqual({ nonMonotonic: [], belowCost: [] });
  });

  it("finds a drop inside the scan too (percent tier makes q*0.5 < q-1)", () => {
    const tiers = [tier({ minQuantity: 2, discountValue: "60" })];
    const a = analyzeTiers({ effectiveUnit: D(1000), tiers });
    // qty1 = 1000, qty2 = 800 -> drop at the boundary.
    expect(a.nonMonotonic[0]).toMatchObject({ fromQuantity: 1, toQuantity: 2 });
  });

  it("flags enabled tiers whose resulting unit falls below cost", () => {
    const a = analyzeTiers({ effectiveUnit: D(10000), costPrice: D(7000), tiers: specTiers });
    expect(a.belowCost).toEqual([{ tierId: "t5", finalUnit: D(6000) }]);
    expect(analyzeTiers({ effectiveUnit: D(10000), costPrice: null, tiers: specTiers }).belowCost).toEqual([]);
  });

  it("ignores disabled tiers and never throws on invalid input", () => {
    const disabled = [tier({ minQuantity: 2, discountValue: "90", isEnabled: false })];
    expect(analyzeTiers({ effectiveUnit: D(1000), costPrice: D(900), tiers: disabled })).toEqual({
      nonMonotonic: [],
      belowCost: [],
    });
    const bad = [tier({ minQuantity: 2, id: "a" }), tier({ minQuantity: 2, id: "b" })];
    expect(() => analyzeTiers({ effectiveUnit: D(1000), tiers: bad })).not.toThrow();
    expect(() => analyzeTiers({ effectiveUnit: D(-5), tiers: specTiers })).not.toThrow();
  });

  it("respects maxQuantity as the scan bound", () => {
    const a = analyzeTiers({ effectiveUnit: D(10000), tiers: specTiers, maxQuantity: 4 });
    expect(a.nonMonotonic).toEqual([]);
  });
});
