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
 *    before that guard existed — or by hand against the shared SQLite file —
 *    would otherwise be trusted at checkout and could zero out a price. Same
 *    reasoning as `activeFlashPercent`, applied to the same class of row.
 *
 * 2. **One formula.** The discount is `subtotal × percent / 100`, quantized
 *    once, and the caller subtracts it. Computing the reduced price directly
 *    (`subtotal × (1 − percent/100)`) is algebraically identical but rounds
 *    differently, and having both spellings in the codebase is how a preview
 *    screen starts quoting a figure the order won't charge.
 */
import { Decimal } from "./money";
import { quantizeMoney } from "./formatters";

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
 * Quantized to 4dp, matching the Numeric(12,4) money columns.
 */
export function bulkDiscountFor(
  lineSubtotal: Decimal.Value,
  rule: BulkRuleFields | null | undefined,
  quantity: number,
): Decimal {
  const percent = activeBulkPercent(rule, quantity);
  if (percent === null) return new Decimal(0);
  return quantizeMoney(new Decimal(lineSubtotal).times(percent).div(100), 4);
}
