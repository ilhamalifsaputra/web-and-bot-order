/**
 * The one selling-price formula for supplier-costed SKUs (Digiflazz today).
 *
 * Pure: no DB, no I/O, Decimal only. Callers load the stored policy (global
 * markup setting, the SKU's category rule, rounding, low-margin threshold) and
 * the SKU's cost/price/override flag, then ask {@link resolveDenominationPrice}
 * what the price is and where it came from.
 *
 * Precedence: a manual SKU price (`priceOverridden`) beats everything; then the
 * category rule; then the global default. A SKU with no known cost has no
 * calculated price at all — a missing cost is never read as zero.
 *
 * Rounding `none` is exactly the pre-refactor behaviour: the markup result
 * stored with `quantizeMoney(x, 4)`, no step rounding.
 */
import { Decimal } from "./money";
import { quantizeMoney } from "./formatters";
import { parseMoneyInput, parsePercentInput } from "./moneyFormat";

export type MarkupType = "percent" | "flat";

/** A markup rule. `type: null` is the blank setting: zero markup (price = cost),
 * whatever `value` holds. `value` is a percent for "percent", rupiah for "flat". */
export interface MarkupRule {
  type: MarkupType | null;
  value: Decimal;
}

export const ROUNDING_POLICIES = ["none", "ceil_100", "ceil_500", "ceil_1000"] as const;
export type RoundingPolicy = (typeof ROUNDING_POLICIES)[number];

/** Which layer the rule-based price came from. */
export type RuleSource = "category_rule" | "global_default";

/** Where the effective price came from. `manual_no_cost`: no cost is known and
 * the SKU is not flagged manual, so the stored price is all there is. */
export type PricingSource = "manual_sku" | RuleSource | "manual_no_cost";

export type PricingWarning = "below_cost" | "low_margin" | "missing_cost";

const CEIL_STEP: Record<Exclude<RoundingPolicy, "none">, number> = {
  ceil_100: 100,
  ceil_500: 500,
  ceil_1000: 1000,
};

export function isRoundingPolicy(value: unknown): value is RoundingPolicy {
  return typeof value === "string" && (ROUNDING_POLICIES as readonly string[]).includes(value);
}

/** percent: C × (1 + M/100); flat: C + M; type null: C. Unrounded. */
export function applyMarkupRule(cost: Decimal, rule: MarkupRule): Decimal {
  // Same operation order as the legacy applyDigiflazzMarkup, so results match
  // digit for digit before quantizing.
  if (rule.type === "percent") return cost.plus(cost.times(rule.value).dividedBy(100));
  if (rule.type === "flat") return cost.plus(rule.value);
  return cost;
}

/** `none`: quantizeMoney(x, 4) (half-up to 4 dp). `ceil_N`: the 4 dp value
 * rounded UP to the next multiple of N (exact multiples stay); no fraction. */
export function applyRounding(x: Decimal, policy: RoundingPolicy): Decimal {
  const at4 = quantizeMoney(x, 4);
  if (policy === "none") return at4;
  const step = CEIL_STEP[policy];
  return at4.dividedBy(step).ceil().times(step);
}

/** Category rule beats global. `null` category means "no rule, inherit". */
export function resolveRule(
  categoryRule: MarkupRule | null,
  globalRule: MarkupRule,
): { rule: MarkupRule; source: RuleSource } {
  return categoryRule
    ? { rule: categoryRule, source: "category_rule" }
    : { rule: globalRule, source: "global_default" };
}

/** price − cost; null when cost is unknown. */
export function grossProfit(price: Decimal, cost: Decimal | null): Decimal | null {
  return cost === null ? null : price.minus(cost);
}

/** (price − cost) / price × 100; null when cost is unknown or price ≤ 0. Unrounded. */
export function grossMarginPct(price: Decimal, cost: Decimal | null): Decimal | null {
  if (cost === null || price.lte(0)) return null;
  return price.minus(cost).dividedBy(price).times(100);
}

/** (price − cost) / cost × 100; null when cost is unknown or ≤ 0. Unrounded. */
export function markupPct(price: Decimal, cost: Decimal | null): Decimal | null {
  if (cost === null || cost.lte(0)) return null;
  return price.minus(cost).dividedBy(cost).times(100);
}

export interface ResolveDenominationPriceInput {
  /** Supplier cost (HPP); null when unknown. Never pass 0 for "unknown". */
  cost: Decimal | null;
  priceOverridden: boolean;
  /** The SKU's stored selling price. */
  currentPrice: Decimal;
  categoryRule: MarkupRule | null;
  globalRule: MarkupRule;
  rounding: RoundingPolicy;
  /** Gross-margin percent below which `low_margin` is raised; null = off. */
  lowMarginWarnPct: Decimal | null;
}

export interface ResolvedDenominationPrice {
  /** Rule-based price from the cost (rounded); null when cost is unknown.
   * Reported even for a manual SKU so the admin can compare. */
  calculatedPrice: Decimal | null;
  /** The price the SKU sells at. */
  effectivePrice: Decimal;
  source: PricingSource;
  /** The rule behind `calculatedPrice`; null when there is no calculated price. */
  appliedRule: MarkupRule | null;
  /** The layer behind `calculatedPrice`; null when there is no calculated price. */
  ruleSource: RuleSource | null;
  /** Data for the admin, never a block. */
  warnings: PricingWarning[];
}

export function resolveDenominationPrice(input: ResolveDenominationPriceInput): ResolvedDenominationPrice {
  const { cost, priceOverridden, currentPrice, categoryRule, globalRule, rounding, lowMarginWarnPct } = input;

  let calculatedPrice: Decimal | null = null;
  let appliedRule: MarkupRule | null = null;
  let ruleSource: RuleSource | null = null;
  if (cost !== null) {
    const resolved = resolveRule(categoryRule, globalRule);
    appliedRule = resolved.rule;
    ruleSource = resolved.source;
    calculatedPrice = applyRounding(applyMarkupRule(cost, resolved.rule), rounding);
  }

  let effectivePrice: Decimal;
  let source: PricingSource;
  if (priceOverridden) {
    effectivePrice = currentPrice;
    source = "manual_sku";
  } else if (calculatedPrice === null) {
    effectivePrice = currentPrice;
    source = "manual_no_cost";
  } else {
    effectivePrice = calculatedPrice;
    source = ruleSource!;
  }

  const warnings: PricingWarning[] = [];
  if (cost === null) {
    warnings.push("missing_cost");
  } else {
    if (effectivePrice.lt(cost)) warnings.push("below_cost");
    if (lowMarginWarnPct !== null) {
      const margin = grossMarginPct(effectivePrice, cost);
      if (margin !== null && margin.lt(lowMarginWarnPct)) warnings.push("low_margin");
    }
  }

  return { calculatedPrice, effectivePrice, source, appliedRule, ruleSource, warnings };
}

/**
 * The markup amount a stored setting holds (a percent for type "percent", a
 * rupiah amount otherwise), or null when the stored value cannot be read as a
 * non-negative number. Blank or unset is a zero markup. The settings route
 * stores the plain decimal (`10`, `12.345`, `1500`), read exactly; anything
 * else (a legacy hand-typed value) is read by its shape — parsePercentInput
 * for a percent (`1,5`), parseMoneyInput for rupiah (`1,500`). `10%`, signs,
 * `NaN` and exponents are null: never thrown, never a negative markup.
 */
export function readStoredMarkupValue(settings: { type: string | null; value: string | null }): Decimal | null {
  const raw = (settings.value ?? "").trim();
  if (raw === "") return new Decimal(0);
  if (/^\d{1,30}(\.\d{1,30})?$/.test(raw)) return new Decimal(raw);
  return settings.type === "percent" ? parsePercentInput(raw) : parseMoneyInput(raw, "IDR");
}

/** A stored `{type, value}` setting pair as a {@link MarkupRule}; null when the
 * value is unreadable (see {@link readStoredMarkupValue}). Any type other than
 * "percent"/"flat" (blank, unset, legacy junk) is zero markup, as before. */
export function readStoredMarkupRule(settings: { type: string | null; value: string | null }): MarkupRule | null {
  const value = readStoredMarkupValue(settings);
  if (value === null) return null;
  const type = settings.type === "percent" || settings.type === "flat" ? settings.type : null;
  return { type, value };
}
