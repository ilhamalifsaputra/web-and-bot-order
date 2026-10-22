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
import { ValidationError } from "./errors";
import {
  percentOfSubtotal,
  priceTieredLine,
  validateTiers,
  type PricingTier,
  type TierValidationError,
  type TieredPrice,
} from "./tierPricing";

export {
  TIER_DISCOUNT_TYPES,
  analyzeTiers,
  validateTiers,
  type PricingTier,
  type TierAnalysis,
  type TierDiscountType,
  type TierValidationError,
  type TierValidationErrorCode,
  type TierValidationResult,
  type TieredPrice,
} from "./tierPricing";

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
 * Whole rupiah, half-up (`wholeRupiah`): the line subtotal is central
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

// ---------------------------------------------------------------------------
// Tiered pricing engine
// ---------------------------------------------------------------------------
//
// The arithmetic (tier selection, rounding, analysis) lives in ./tierPricing.ts
// so the admin client can carry a byte-identical copy; its header documents the
// rounding rules. This file adds the checked entry point and the legacy adapter.

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
  return priceTieredLine(unit, quantity, tiers, currency);
}

/**
 * The legacy single BulkPricing rule as one PERCENTAGE tier (id "legacy"), so
 * a legacy caller can route through the engine and charge the same rupiah.
 * Returns [] for no rule and for a rule activeBulkPercent refuses (it never
 * discounted anything). A minQuantity-1 rule converts as-is: a tier at 1 is a
 * discount on the base price, exactly what bulkDiscountFor applies.
 */
export function tiersFromLegacyRule(rule: BulkRuleFields | null | undefined): PricingTier[] {
  if (!rule) return [];
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
