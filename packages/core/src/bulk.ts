/**
 * Quantity ("bulk") discount pricing — the single place that decides how much
 * a bulk rule takes off a line, and whether it applies at all.
 *
 * Sibling of ./flash.ts, and deliberately shaped like it. A bulk rule lives on
 * its own row (BulkPricing: minQuantity + discountPercent, keyed by
 * denomination) and is layered ON TOP of whatever `effectiveUnitPrice` returns,
 * exactly as it was before flash sales existed. Vouchers are then computed on
 * top of the bulk-reduced subtotal.
 *
 * Two rules this module exists to keep singular:
 *
 * 1. **Validate on read, not just on write.** `upsertBulkPricing` (@app/db
 *    crud/catalog) already rejects a percent outside (0,100], but a row written
 *    before that guard existed — or by hand against the shared database —
 *    would otherwise be trusted at checkout and could zero out a price. Same
 *    reasoning as `activeFlashPercent`, applied to the same class of row.
 *
 * 2. **One formula.** The discount is `subtotal × percent / 100`, rounded
 *    once to whole rupiah, and the caller subtracts it. Computing the reduced price directly
 *    (`subtotal × (1 − percent/100)`) is algebraically identical but rounds
 *    differently, and having both spellings in the codebase is how a preview
 *    screen starts quoting a figure the order won't charge.
 */
import { Decimal } from "./money";
import { quantizeMoney, wholeRupiah } from "./formatters";
import { ValidationError } from "./errors";

/** The two columns that define a bulk rule, as stored on BulkPricing. */
export type BulkRuleFields = {
  minQuantity: number;
  discountPercent: Decimal.Value;
};

/**
 * The percent off in effect for `quantity`, or null when this rule doesn't
 * apply (missing, malformed, or the line simply isn't big enough).
 *
 * `minQuantity` must be a whole number of at least 1: a rule with 0 or a
 * negative threshold would fire on every single-unit order, turning a "buy 5+"
 * promotion into a permanent price cut nobody configured.
 */
export function activeBulkPercent(
  rule: BulkRuleFields | null | undefined,
  quantity: number,
): Decimal | null {
  if (!rule) return null;
  if (!Number.isInteger(rule.minQuantity) || rule.minQuantity < 1) return null;
  if (!Number.isFinite(quantity) || quantity < rule.minQuantity) return null;
  let percent: Decimal;
  try {
    percent = new Decimal(rule.discountPercent);
  } catch {
    return null;
  }
  if (!percent.isFinite() || percent.lessThanOrEqualTo(0) || percent.greaterThan(100)) {
    return null;
  }
  return percent;
}

/** True when `rule` discounts a line of `quantity` units. */
export function isBulkActive(rule: BulkRuleFields | null | undefined, quantity: number): boolean {
  return activeBulkPercent(rule, quantity) !== null;
}

/**
 * How much `rule` takes off a line whose subtotal is `lineSubtotal` — a
 * positive amount the caller subtracts, or zero when the rule doesn't apply.
 * Whole rupiah, half-up ({@link wholeRupiah}): the line subtotal is central
 * IDR, and a fractional discount made the preview rows and the charge disagree
 * (B5, money audit). Per line, so a cart's bulk discount is the sum of what
 * each line shows.
 */
export function bulkDiscountFor(
  lineSubtotal: Decimal.Value,
  rule: BulkRuleFields | null | undefined,
  quantity: number,
): Decimal {
  const percent = activeBulkPercent(rule, quantity);
  if (percent === null) return new Decimal(0);
  return percentOfSubtotal(lineSubtotal, percent);
}

/**
 * THE percentage formula, shared by the legacy rule and PERCENTAGE tiers:
 * `subtotal × percent / 100`, rounded once to whole rupiah, half-up. Keeping
 * one spelling is what makes a migrated legacy rule charge the same rupiah.
 */
function percentOfSubtotal(subtotal: Decimal.Value, percent: Decimal): Decimal {
  return wholeRupiah(new Decimal(subtotal).times(percent).div(100));
}

// ---------------------------------------------------------------------------
// Tiered pricing engine
// ---------------------------------------------------------------------------
//
// A denomination may carry several quantity tiers; the line is priced by the
// enabled tier with the highest `minQuantity` that is <= the quantity. Tiers
// sit ON TOP of `effectiveUnit` (which already includes reseller/flash), and
// vouchers are computed on top of the tier-reduced subtotal, as before.
//
// Rounding rules (IDR, the central currency):
//   - PERCENTAGE: totalDiscount = wholeRupiah(originalSubtotal × pct / 100) —
//     the legacy bulkDiscountFor formula, unchanged (historic rounding).
//   - FIXED_AMOUNT_OFF_PER_UNIT: discountPerUnit = wholeRupiah(min(value,
//     effectiveUnit)); totalDiscount = discountPerUnit × quantity.
//   - FIXED_UNIT_PRICE: discountPerUnit = wholeRupiah(effectiveUnit − value)
//     only when value < effectiveUnit, else 0 (a fixed price never raises the
//     price); totalDiscount = discountPerUnit × quantity.
//   - totalDiscount is clamped to [0, originalSubtotal]; it is the
//     authoritative figure. finalSubtotal = originalSubtotal − totalDiscount.
//   - finalUnitPrice is display only: finalSubtotal / quantity, 4dp half-up.
//     For PERCENTAGE, discountPerUnit is likewise totalDiscount / quantity, 4dp.
// Any other currency rounds amounts to 4dp half-up instead of whole rupiah.

export type TierDiscountType = "PERCENTAGE" | "FIXED_AMOUNT_OFF_PER_UNIT" | "FIXED_UNIT_PRICE";

const TIER_DISCOUNT_TYPES: readonly TierDiscountType[] = [
  "PERCENTAGE",
  "FIXED_AMOUNT_OFF_PER_UNIT",
  "FIXED_UNIT_PRICE",
];

export interface PricingTier {
  id: string;
  minQuantity: number;
  discountType: TierDiscountType;
  discountValue: Decimal | string | number;
  isEnabled: boolean;
  sortOrder?: number;
}

export type TierValidationErrorCode =
  | "INVALID_MIN_QUANTITY"
  | "DUPLICATE_MIN_QUANTITY"
  | "INVALID_VALUE"
  | "INVALID_PERCENTAGE"
  | "UNKNOWN_TYPE";

export interface TierValidationError {
  code: TierValidationErrorCode;
  tierId?: string;
  message: string;
}

export type TierValidationResult = { ok: true } | { ok: false; errors: TierValidationError[] };

export type TieredPricingErrorCode = "INVALID_QUANTITY" | "INVALID_EFFECTIVE_UNIT" | "INVALID_TIERS";

/** Thrown by resolveTieredPrice; `errors` lists the tier problems for INVALID_TIERS. */
export class TieredPricingError extends ValidationError {
  constructor(
    public readonly code: TieredPricingErrorCode,
    public readonly errors: TierValidationError[] = [],
  ) {
    super(code === "INVALID_TIERS" ? "error.invalid_pricing_tiers" : "error.invalid_pricing_quantity", {
      code,
    });
    this.name = "TieredPricingError";
  }
}

export interface TieredPrice {
  baseUnitPrice: Decimal;
  quantity: number;
  appliedTier: PricingTier | null;
  /** Display only: finalSubtotal / quantity, 4dp half-up. */
  finalUnitPrice: Decimal;
  originalSubtotal: Decimal;
  discountPerUnit: Decimal;
  /** The authoritative discount for the line. */
  totalDiscount: Decimal;
  finalSubtotal: Decimal;
  currency: string;
}

function parseValue(v: PricingTier["discountValue"]): Decimal | null {
  try {
    const d = new Decimal(v);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/**
 * Every problem with a tier set, or ok. Duplicate minQuantity is checked
 * across ALL tiers (disabled included): enabling one later must not make the
 * set ambiguous. There is deliberately no maximum tier count.
 */
export function validateTiers(tiers: readonly PricingTier[]): TierValidationResult {
  const errors: TierValidationError[] = [];
  const seen = new Set<number>();
  for (const t of tiers) {
    if (!Number.isInteger(t.minQuantity) || t.minQuantity < 2) {
      errors.push({
        code: "INVALID_MIN_QUANTITY",
        tierId: t.id,
        message: "Minimum quantity must be a whole number of at least 2; quantity 1 is the base price.",
      });
    } else if (seen.has(t.minQuantity)) {
      errors.push({
        code: "DUPLICATE_MIN_QUANTITY",
        tierId: t.id,
        message: `Two tiers start at quantity ${t.minQuantity}, so the price would be ambiguous.`,
      });
    } else {
      seen.add(t.minQuantity);
    }
    if (!TIER_DISCOUNT_TYPES.includes(t.discountType)) {
      errors.push({ code: "UNKNOWN_TYPE", tierId: t.id, message: "The discount type is not recognised." });
      continue;
    }
    const value = parseValue(t.discountValue);
    if (value === null || value.lessThanOrEqualTo(0)) {
      errors.push({ code: "INVALID_VALUE", tierId: t.id, message: "The discount value must be a number above zero." });
      continue;
    }
    if (t.discountType === "PERCENTAGE" && value.greaterThan(100)) {
      errors.push({
        code: "INVALID_PERCENTAGE",
        tierId: t.id,
        message: "A percentage discount must be above 0 and at most 100.",
      });
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function roundFor(currency: string): (v: Decimal.Value) => Decimal {
  return currency === "IDR" ? wholeRupiah : (v) => quantizeMoney(v, 4);
}

/** The engine core — assumes validated tiers and a valid unit and quantity. */
function priceLine(
  effectiveUnit: Decimal,
  quantity: number,
  tiers: readonly PricingTier[],
  currency: string,
): TieredPrice {
  const round = roundFor(currency);
  const originalSubtotal = effectiveUnit.times(quantity);
  let applied: PricingTier | null = null;
  for (const t of tiers) {
    if (!t.isEnabled || t.minQuantity > quantity) continue;
    if (applied === null || t.minQuantity > applied.minQuantity) applied = t;
  }

  let totalDiscount = new Decimal(0);
  let perUnit: Decimal | null = null;
  if (applied) {
    const value = new Decimal(applied.discountValue);
    if (applied.discountType === "PERCENTAGE") {
      totalDiscount =
        currency === "IDR"
          ? percentOfSubtotal(originalSubtotal, value)
          : round(originalSubtotal.times(value).div(100));
    } else {
      let raw: Decimal;
      if (applied.discountType === "FIXED_AMOUNT_OFF_PER_UNIT") raw = Decimal.min(value, effectiveUnit);
      else raw = value.lessThan(effectiveUnit) ? effectiveUnit.minus(value) : new Decimal(0);
      perUnit = Decimal.min(round(raw), effectiveUnit);
      totalDiscount = perUnit.times(quantity);
    }
  }
  totalDiscount = Decimal.max(0, Decimal.min(totalDiscount, originalSubtotal));
  const finalSubtotal = originalSubtotal.minus(totalDiscount);
  const discountPerUnit =
    perUnit !== null && perUnit.times(quantity).equals(totalDiscount)
      ? perUnit
      : quantizeMoney(totalDiscount.div(quantity), 4);
  return {
    baseUnitPrice: effectiveUnit,
    quantity,
    appliedTier: applied,
    finalUnitPrice: quantizeMoney(finalSubtotal.div(quantity), 4),
    originalSubtotal,
    discountPerUnit,
    totalDiscount,
    finalSubtotal,
    currency,
  };
}

/**
 * Price one line of `quantity` units at `effectiveUnit` (already reseller- and
 * flash-adjusted) under `tiers`. Throws TieredPricingError for a quantity that
 * is not a whole number >= 1, a negative/non-finite unit, or an invalid or
 * ambiguous tier set — it never guesses a price.
 */
export function resolveTieredPrice(args: {
  effectiveUnit: Decimal;
  quantity: number;
  tiers: readonly PricingTier[];
  currency?: string;
}): TieredPrice {
  const { quantity, tiers, currency = "IDR" } = args;
  if (!Number.isInteger(quantity) || quantity < 1) throw new TieredPricingError("INVALID_QUANTITY");
  const unit = new Decimal(args.effectiveUnit);
  if (!unit.isFinite() || unit.isNegative()) throw new TieredPricingError("INVALID_EFFECTIVE_UNIT");
  const validation = validateTiers(tiers);
  if (!validation.ok) throw new TieredPricingError("INVALID_TIERS", validation.errors);
  return priceLine(unit, quantity, tiers, currency);
}

/**
 * The legacy single BulkPricing rule as one PERCENTAGE tier (id "legacy"), so
 * a legacy caller can route through the engine and charge the same rupiah.
 * Returns [] for no rule, for a rule activeBulkPercent refuses (it never
 * discounted anything), and for minQuantity 1 — not representable as a tier
 * because quantity 1 is the base price. bulkDiscountFor still honours such a
 * row, so migrate it explicitly rather than routing it through here.
 */
export function tiersFromLegacyRule(rule: BulkRuleFields | null | undefined): PricingTier[] {
  if (!rule || !Number.isInteger(rule.minQuantity) || rule.minQuantity < 2) return [];
  const percent = activeBulkPercent(rule, rule.minQuantity);
  if (percent === null) return [];
  return [
    {
      id: "legacy",
      minQuantity: rule.minQuantity,
      discountType: "PERCENTAGE",
      discountValue: percent,
      isEnabled: true,
      sortOrder: 0,
    },
  ];
}

/** Quantities scanned one by one in analyzeTiers; tier boundaries beyond it are still checked. */
const ANALYZE_SCAN_LIMIT = 1000;

export interface TierAnalysis {
  nonMonotonic: { fromQuantity: number; toQuantity: number; fromTotal: Decimal; toTotal: Decimal }[];
  belowCost: { tierId: string; finalUnit: Decimal }[];
}

/**
 * Admin warnings for a tier set — never throws, never blocks a save:
 *  - nonMonotonic: where buying one more unit costs LESS in total
 *    (total(q+1) < total(q)). Checked at every enabled tier boundary
 *    (minQuantity − 1 → minQuantity) up to `maxQuantity`, and across a
 *    bounded scan from 1 (default bound: highest enabled minQuantity + 1).
 *  - belowCost: enabled tiers whose unit price at their own minQuantity is
 *    below `costPrice`.
 * An invalid tier set or unit yields no warnings; validateTiers reports it.
 */
export function analyzeTiers(args: {
  effectiveUnit: Decimal;
  costPrice?: Decimal | null;
  tiers: readonly PricingTier[];
  maxQuantity?: number;
  currency?: string;
}): TierAnalysis {
  const empty: TierAnalysis = { nonMonotonic: [], belowCost: [] };
  const { tiers, currency = "IDR" } = args;
  let unit: Decimal;
  try {
    unit = new Decimal(args.effectiveUnit);
  } catch {
    return empty;
  }
  if (!unit.isFinite() || unit.isNegative() || !validateTiers(tiers).ok) return empty;
  const enabled = tiers.filter((t) => t.isEnabled);
  if (enabled.length === 0) return empty;

  const highest = Math.max(...enabled.map((t) => t.minQuantity));
  const bound =
    args.maxQuantity !== undefined && Number.isFinite(args.maxQuantity)
      ? Math.floor(args.maxQuantity)
      : highest + 1;
  const total = (q: number) => priceLine(unit, q, tiers, currency).finalSubtotal;

  const steps = new Set<number>();
  for (let q = 1; q < Math.min(bound, ANALYZE_SCAN_LIMIT); q++) steps.add(q);
  for (const t of enabled) if (t.minQuantity <= bound) steps.add(t.minQuantity - 1);

  const nonMonotonic: TierAnalysis["nonMonotonic"] = [];
  for (const q of [...steps].sort((a, b) => a - b)) {
    const fromTotal = total(q);
    const toTotal = total(q + 1);
    if (toTotal.lessThan(fromTotal)) nonMonotonic.push({ fromQuantity: q, toQuantity: q + 1, fromTotal, toTotal });
  }

  const belowCost: TierAnalysis["belowCost"] = [];
  if (args.costPrice != null) {
    const cost = new Decimal(args.costPrice);
    for (const t of [...enabled].sort((a, b) => a.minQuantity - b.minQuantity)) {
      const finalUnit = priceLine(unit, t.minQuantity, [t], currency).finalUnitPrice;
      if (finalUnit.lessThan(cost)) belowCost.push({ tierId: t.id, finalUnit });
    }
  }
  return { nonMonotonic, belowCost };
}
