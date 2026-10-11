import { describe, expect, it } from "vitest";
import { Decimal } from "./money";
import { quantizeMoney } from "./formatters";
import { parseMoneyInput, parsePercentInput } from "./moneyFormat";
import {
  applyMarkupRule,
  applyRounding,
  grossMarginPct,
  grossProfit,
  markupPct,
  readStoredMarkupRule,
  readStoredMarkupValue,
  resolveDenominationPrice,
  resolveRule,
  type MarkupRule,
  type ResolveDenominationPriceInput,
} from "./pricingRule";

const D = (v: Decimal.Value) => new Decimal(v);
const pct = (v: Decimal.Value): MarkupRule => ({ type: "percent", value: D(v) });
const flat = (v: Decimal.Value): MarkupRule => ({ type: "flat", value: D(v) });
const none: MarkupRule = { type: null, value: D(0) };

function input(over: Partial<ResolveDenominationPriceInput>): ResolveDenominationPriceInput {
  return {
    cost: D(100000),
    priceOverridden: false,
    currentPrice: D(100000),
    categoryRule: null,
    globalRule: pct(15),
    rounding: "none",
    lowMarginWarnPct: null,
    ...over,
  };
}

/**
 * Frozen copy of the pre-refactor formula in packages/db/src/crud/digiflazz.ts
 * (`readDigiflazzMarkup` + `applyDigiflazzMarkup`, then `quantizeMoney(x, 4)` at
 * every write site). Kept verbatim here so the regression test below compares
 * the new resolver against the old behaviour, not against itself.
 */
function legacyRead(settings: { type: string | null; value: string | null }): Decimal | null {
  const raw = (settings.value ?? "").trim();
  if (raw === "") return new Decimal(0);
  if (/^\d{1,30}(\.\d{1,30})?$/.test(raw)) return new Decimal(raw);
  return settings.type === "percent" ? parsePercentInput(raw) : parseMoneyInput(raw, "IDR");
}
function legacyApply(cost: Decimal, settings: { type: string | null; value: string | null }): Decimal {
  const amount = legacyRead(settings);
  if (amount === null) throw new Error("unreadable");
  if (settings.type === "percent") return cost.plus(cost.times(amount).dividedBy(100));
  if (settings.type === "flat") return cost.plus(amount);
  return cost;
}

describe("applyMarkupRule", () => {
  it("percent: C × (1 + M/100)", () => {
    expect(applyMarkupRule(D(100000), pct(15)).toString()).toBe("115000");
    expect(applyMarkupRule(D(1234.5), pct("12.5")).toString()).toBe("1388.8125");
  });
  it("flat: C + M", () => {
    expect(applyMarkupRule(D(100000), flat(2500)).toString()).toBe("102500");
  });
  it("null type returns the cost unchanged (blank setting = zero markup)", () => {
    expect(applyMarkupRule(D(100000), none).toString()).toBe("100000");
    expect(applyMarkupRule(D(100000), { type: null, value: D(50) }).toString()).toBe("100000");
  });
  it("zero cost stays a real zero cost (not missing)", () => {
    expect(applyMarkupRule(D(0), pct(15)).toString()).toBe("0");
    expect(applyMarkupRule(D(0), flat(500)).toString()).toBe("500");
  });
});

describe("applyRounding", () => {
  it("none is exactly quantizeMoney(x, 4), half-up", () => {
    expect(applyRounding(D("115000.00005"), "none").toString()).toBe("115000.0001");
    expect(applyRounding(D("115000.00004"), "none").toString()).toBe("115000");
    expect(applyRounding(D("1388.8125"), "none").toString()).toBe("1388.8125");
  });
  it("ceil_100 rounds up to the next multiple of 100", () => {
    expect(applyRounding(D("115000.0001"), "ceil_100").toString()).toBe("115100");
    expect(applyRounding(D("115001"), "ceil_100").toString()).toBe("115100");
    expect(applyRounding(D("115050"), "ceil_100").toString()).toBe("115100"); // tie still goes up
  });
  it("ceil_N keeps exact multiples", () => {
    expect(applyRounding(D(115000), "ceil_100").toString()).toBe("115000");
    expect(applyRounding(D(115000), "ceil_500").toString()).toBe("115000");
    expect(applyRounding(D(115000), "ceil_1000").toString()).toBe("115000");
  });
  it("ceil_500 and ceil_1000", () => {
    expect(applyRounding(D(115001), "ceil_500").toString()).toBe("115500");
    expect(applyRounding(D(115250), "ceil_500").toString()).toBe("115500"); // tie
    expect(applyRounding(D(115500), "ceil_1000").toString()).toBe("116000"); // tie
    expect(applyRounding(D("110000.5"), "ceil_1000").toString()).toBe("111000");
  });
  it("ceil is computed on the 4dp value (sub-4dp dust never bumps a step)", () => {
    expect(applyRounding(D("115000.00004"), "ceil_100").toString()).toBe("115000");
    expect(applyRounding(D("115000.00005"), "ceil_100").toString()).toBe("115100");
  });
  it("ceil result has no fractional part", () => {
    const r = applyRounding(D("1388.8125"), "ceil_100");
    expect(r.toString()).toBe("1400");
    expect(r.decimalPlaces()).toBe(0);
  });
  it("zero stays zero", () => {
    expect(applyRounding(D(0), "ceil_1000").toString()).toBe("0");
  });
});

describe("resolveRule", () => {
  it("category rule beats global", () => {
    expect(resolveRule(pct(10), pct(15))).toEqual({ rule: pct(10), source: "category_rule" });
  });
  it("no category rule falls back to global", () => {
    expect(resolveRule(null, pct(15))).toEqual({ rule: pct(15), source: "global_default" });
  });
  it("a category rule of zero markup still wins (it is a rule, not absence)", () => {
    expect(resolveRule(none, pct(15))).toEqual({ rule: none, source: "category_rule" });
  });
});

describe("margins", () => {
  it("grossProfit = price − cost; null when cost unknown", () => {
    expect(grossProfit(D(115000), D(100000))?.toString()).toBe("15000");
    expect(grossProfit(D(110000), D(115000))?.toString()).toBe("-5000");
    expect(grossProfit(D(35000), null)).toBeNull();
  });
  it("grossMarginPct = (price − cost)/price × 100", () => {
    expect(grossMarginPct(D(125000), D(100000))?.toString()).toBe("20");
    expect(grossMarginPct(D(100000), D(0))?.toString()).toBe("100");
  });
  it("grossMarginPct is null for unknown cost or price ≤ 0", () => {
    expect(grossMarginPct(D(35000), null)).toBeNull();
    expect(grossMarginPct(D(0), D(100))).toBeNull();
    expect(grossMarginPct(D(-1), D(100))).toBeNull();
  });
  it("markupPct = (price − cost)/cost × 100; null for unknown or non-positive cost", () => {
    expect(markupPct(D(115000), D(100000))?.toString()).toBe("15");
    expect(markupPct(D(110000), D(115000))?.toFixed(4)).toBe("-4.3478");
    expect(markupPct(D(100), null)).toBeNull();
    expect(markupPct(D(100), D(0))).toBeNull();
  });
});

describe("resolveDenominationPrice", () => {
  it("Scenario A: global 15% on 100000 → 115000 from global_default", () => {
    const r = resolveDenominationPrice(input({}));
    expect(r.calculatedPrice?.toString()).toBe("115000");
    expect(r.effectivePrice.toString()).toBe("115000");
    expect(r.source).toBe("global_default");
    expect(r.appliedRule).toEqual(pct(15));
    expect(r.warnings).toEqual([]);
  });

  it("Scenario B: category 10% beats global 15% → 110000 from category_rule", () => {
    const r = resolveDenominationPrice(input({ categoryRule: pct(10) }));
    expect(r.calculatedPrice?.toString()).toBe("110000");
    expect(r.effectivePrice.toString()).toBe("110000");
    expect(r.source).toBe("category_rule");
    expect(r.ruleSource).toBe("category_rule");
    expect(r.appliedRule).toEqual(pct(10));
  });

  it("Scenario D: a manual SKU price beats category and global", () => {
    const r = resolveDenominationPrice(
      input({ categoryRule: pct(10), priceOverridden: true, currentPrice: D(130000) }),
    );
    expect(r.effectivePrice.toString()).toBe("130000");
    expect(r.source).toBe("manual_sku");
    // The rule-based price is still reported so the admin can compare.
    expect(r.calculatedPrice?.toString()).toBe("110000");
    expect(r.ruleSource).toBe("category_rule");
  });

  it("an override returns the current price untouched, even with rounding on", () => {
    const r = resolveDenominationPrice(
      input({ priceOverridden: true, currentPrice: D("123456.789"), rounding: "ceil_1000" }),
    );
    expect(r.effectivePrice.toString()).toBe("123456.789");
    expect(r.calculatedPrice?.toString()).toBe("115000");
  });

  it("Scenario E: cost rises above the manual price → kept, flagged below_cost", () => {
    const r = resolveDenominationPrice(
      input({ cost: D(115000), priceOverridden: true, currentPrice: D(110000) }),
    );
    expect(r.effectivePrice.toString()).toBe("110000");
    expect(r.source).toBe("manual_sku");
    expect(r.warnings).toContain("below_cost");
    expect(r.warnings).not.toContain("low_margin"); // threshold off
    expect(grossMarginPct(r.effectivePrice, D(115000))!.isNegative()).toBe(true);
  });

  it("Scenario E with a low-margin threshold also flags low_margin", () => {
    const r = resolveDenominationPrice(
      input({ cost: D(115000), priceOverridden: true, currentPrice: D(110000), lowMarginWarnPct: D(5) }),
    );
    expect(r.warnings).toEqual(expect.arrayContaining(["below_cost", "low_margin"]));
  });

  it("Scenario F: no cost, not overridden → manual price kept, no calculated price", () => {
    for (const globalRule of [pct(15), pct(20)]) {
      const r = resolveDenominationPrice(
        input({ cost: null, currentPrice: D(35000), globalRule, lowMarginWarnPct: D(10) }),
      );
      expect(r.calculatedPrice).toBeNull();
      expect(r.effectivePrice.toString()).toBe("35000");
      expect(r.source).toBe("manual_no_cost");
      expect(r.appliedRule).toBeNull();
      expect(r.warnings).toEqual(["missing_cost"]);
    }
    expect(grossMarginPct(D(35000), null)).toBeNull();
  });

  it("no cost but overridden → manual_sku, missing_cost warning", () => {
    const r = resolveDenominationPrice(input({ cost: null, priceOverridden: true, currentPrice: D(35000) }));
    expect(r.source).toBe("manual_sku");
    expect(r.calculatedPrice).toBeNull();
    expect(r.warnings).toEqual(["missing_cost"]);
  });

  it("null cost is never treated as zero cost", () => {
    const nullCost = resolveDenominationPrice(input({ cost: null, currentPrice: D(5000), globalRule: flat(500) }));
    const zeroCost = resolveDenominationPrice(input({ cost: D(0), currentPrice: D(5000), globalRule: flat(500) }));
    expect(nullCost.effectivePrice.toString()).toBe("5000");
    expect(nullCost.calculatedPrice).toBeNull();
    expect(zeroCost.calculatedPrice?.toString()).toBe("500");
    expect(zeroCost.effectivePrice.toString()).toBe("500");
    expect(zeroCost.warnings).toEqual([]);
  });

  it("applies rounding to the calculated price", () => {
    const r = resolveDenominationPrice(input({ cost: D(100001), rounding: "ceil_500" }));
    expect(r.calculatedPrice?.toString()).toBe("115500");
    expect(r.effectivePrice.toString()).toBe("115500");
  });

  it("blank global rule (type null) is zero markup: price = cost", () => {
    const r = resolveDenominationPrice(input({ globalRule: none }));
    expect(r.effectivePrice.toString()).toBe("100000");
    expect(r.source).toBe("global_default");
  });

  it("low_margin fires only below the threshold and only when the threshold is set", () => {
    // 115000 on 100000 = 13.04% gross margin
    expect(resolveDenominationPrice(input({ lowMarginWarnPct: D(15) })).warnings).toEqual(["low_margin"]);
    expect(resolveDenominationPrice(input({ lowMarginWarnPct: D(13) })).warnings).toEqual([]);
    expect(resolveDenominationPrice(input({ lowMarginWarnPct: null })).warnings).toEqual([]);
  });

  it("below_cost on a calculated price is impossible for non-negative rules but a manual price can be", () => {
    const r = resolveDenominationPrice(input({ priceOverridden: true, currentPrice: D(99999) }));
    expect(r.warnings).toEqual(["below_cost"]);
  });
});

describe("readStoredMarkupValue / readStoredMarkupRule", () => {
  it("blank or unset is zero", () => {
    expect(readStoredMarkupValue({ type: "percent", value: null })?.toString()).toBe("0");
    expect(readStoredMarkupValue({ type: null, value: "  " })?.toString()).toBe("0");
  });
  it("plain decimals are read exactly", () => {
    expect(readStoredMarkupValue({ type: "percent", value: "12.345" })?.toString()).toBe("12.345");
    expect(readStoredMarkupValue({ type: "flat", value: "1500" })?.toString()).toBe("1500");
  });
  it("legacy hand-typed values are read by shape", () => {
    expect(readStoredMarkupValue({ type: "percent", value: "1,5" })?.toString()).toBe("1.5");
    expect(readStoredMarkupValue({ type: "flat", value: "1,500" })?.toString()).toBe("1500");
    // A plain decimal is the settings route's own format and is read exactly.
    expect(readStoredMarkupValue({ type: "flat", value: "1.500" })?.toString()).toBe("1.5");
  });
  it("unreadable values are null, never thrown", () => {
    for (const value of ["10%", "-5", "NaN", "1e3", "abc"]) {
      expect(readStoredMarkupValue({ type: "percent", value })).toBeNull();
    }
    expect(readStoredMarkupRule({ type: "percent", value: "10%" })).toBeNull();
  });
  it("readStoredMarkupRule maps the stored type", () => {
    expect(readStoredMarkupRule({ type: "percent", value: "15" })).toEqual(pct(15));
    expect(readStoredMarkupRule({ type: "flat", value: "2500" })).toEqual(flat(2500));
    expect(readStoredMarkupRule({ type: null, value: null })).toEqual(none);
    expect(readStoredMarkupRule({ type: "blank", value: "7" })).toEqual({ type: null, value: D(7) });
  });
});

describe("regression: rounding none reproduces the pre-refactor formula exactly", () => {
  const costs = ["0", "1", "1234.5", "99999.9999", "100000", "123456.789", "5000000", "7.12345"];
  const settings: { type: string | null; value: string | null }[] = [
    { type: "percent", value: "15" },
    { type: "percent", value: "12.345" },
    { type: "percent", value: "1,5" },
    { type: "percent", value: "0" },
    { type: "percent", value: null },
    { type: "flat", value: "1500" },
    { type: "flat", value: "1.500" },
    { type: "flat", value: "1,500" },
    { type: "flat", value: "0.33333" },
    { type: null, value: null },
    { type: "blank", value: "10" },
  ];
  for (const s of settings) {
    for (const c of costs) {
      it(`cost ${c} with ${s.type}/${s.value}`, () => {
        const legacy = quantizeMoney(legacyApply(D(c), s), 4);
        const rule = readStoredMarkupRule(s);
        expect(rule).not.toBeNull();
        const r = resolveDenominationPrice(
          input({ cost: D(c), globalRule: rule!, currentPrice: D(1), rounding: "none" }),
        );
        expect(r.effectivePrice.toString()).toBe(legacy.toString());
        expect(r.calculatedPrice!.equals(legacy)).toBe(true);
      });
    }
  }
});
