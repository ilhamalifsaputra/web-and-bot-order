/**
 * The tiered pricing ARITHMETIC: which tier prices a line, what it takes off, and the admin warnings for a tier
 * set. `./bulk.ts` is the public engine (it adds the throwing `resolveTieredPrice`, the legacy single-rule
 * adapters and the error type) and re-exports everything here; nothing else should import this file directly.
 *
 * Dependency-free (decimal.js only) and browser-safe on purpose. The admin client must not import `@app/core`
 * (scripts/check-frontend-boundaries.ts), yet its tier editor must preview the exact price checkout will charge,
 * so `apps/web-admin/client/src/lib/tierPricing.ts` is a byte-identical COPY of this file;
 * `packages/core/src/bulk.test.ts` fails when the two differ. Edit this file, then copy it over.
 *
 * A denomination may carry several quantity tiers; the line is priced by the enabled tier with the highest
 * `minQuantity` that is <= the quantity. Tiers sit ON TOP of `effectiveUnit` (which already includes
 * reseller/flash), and vouchers are computed on top of the tier-reduced subtotal, as before.
 *
 * Rounding rules (IDR, the central currency):
 *   - PERCENTAGE: totalDiscount = wholeRupiah(originalSubtotal × pct / 100) — the legacy bulkDiscountFor
 *     formula, unchanged (historic rounding).
 *   - FIXED_AMOUNT_OFF_PER_UNIT: discountPerUnit = wholeRupiah(min(value, effectiveUnit));
 *     totalDiscount = discountPerUnit × quantity.
 *   - FIXED_UNIT_PRICE: discountPerUnit = wholeRupiah(effectiveUnit − value) only when value < effectiveUnit,
 *     else 0 (a fixed price never raises the price); totalDiscount = discountPerUnit × quantity.
 *   - totalDiscount is clamped to [0, originalSubtotal]; it is the authoritative figure.
 *     finalSubtotal = originalSubtotal − totalDiscount.
 *   - finalUnitPrice is display only: finalSubtotal / quantity, 4dp half-up. For PERCENTAGE, discountPerUnit is
 *     likewise totalDiscount / quantity, 4dp.
 * Any other currency rounds amounts to 4dp half-up instead of whole rupiah.
 */
import Decimal from "decimal.js";

/** Half-up to `decimals` places — the same rule as `quantizeMoney` in ./formatters.ts. */
function halfUp(amount: Decimal.Value, decimals: number): Decimal {
  return new Decimal(amount).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
}

/**
 * THE percentage formula, shared by the legacy rule and PERCENTAGE tiers: `subtotal × percent / 100`, rounded
 * once to whole rupiah, half-up. Keeping one spelling is what makes a migrated legacy rule charge the same rupiah.
 */
export function percentOfSubtotal(subtotal: Decimal.Value, percent: Decimal): Decimal {
  return halfUp(new Decimal(subtotal).times(percent).div(100), 0);
}

export type TierDiscountType = "PERCENTAGE" | "FIXED_AMOUNT_OFF_PER_UNIT" | "FIXED_UNIT_PRICE";

export const TIER_DISCOUNT_TYPES: readonly TierDiscountType[] = [
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
 * Every problem with a tier set, or ok. Duplicate minQuantity is checked across ALL tiers (disabled included):
 * enabling one later must not make the set ambiguous. There is deliberately no maximum tier count.
 */
export function validateTiers(tiers: readonly PricingTier[]): TierValidationResult {
  const errors: TierValidationError[] = [];
  const seen = new Set<number>();
  for (const t of tiers) {
    if (!Number.isInteger(t.minQuantity) || t.minQuantity < 1) {
      errors.push({
        code: "INVALID_MIN_QUANTITY",
        tierId: t.id,
        message: "Minimum quantity must be a whole number of at least 1.",
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
  return currency === "IDR" ? (v) => halfUp(v, 0) : (v) => halfUp(v, 4);
}

/**
 * The engine core — assumes validated tiers and a valid unit and quantity. Callers outside the engine use
 * `resolveTieredPrice` (./bulk.ts), which checks those first and throws instead of guessing.
 */
export function priceTieredLine(
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
      : halfUp(totalDiscount.div(quantity), 4);
  return {
    baseUnitPrice: effectiveUnit,
    quantity,
    appliedTier: applied,
    finalUnitPrice: halfUp(finalSubtotal.div(quantity), 4),
    originalSubtotal,
    discountPerUnit,
    totalDiscount,
    finalSubtotal,
    currency,
  };
}

/** Quantities scanned one by one in analyzeTiers; tier boundaries beyond it are still checked. */
const ANALYZE_SCAN_LIMIT = 1000;

export interface TierAnalysis {
  nonMonotonic: { fromQuantity: number; toQuantity: number; fromTotal: Decimal; toTotal: Decimal }[];
  belowCost: { tierId: string; finalUnit: Decimal }[];
}

/**
 * Admin warnings for a tier set — never throws, never blocks a save:
 *  - nonMonotonic: where buying one more unit costs LESS in total (total(q+1) < total(q)). Checked at every
 *    enabled tier boundary (minQuantity − 1 → minQuantity) up to `maxQuantity`, and across a bounded scan from 1
 *    (default bound: highest enabled minQuantity + 1).
 *  - belowCost: enabled tiers whose unit price at their own minQuantity is below `costPrice`.
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
  const total = (q: number) => priceTieredLine(unit, q, tiers, currency).finalSubtotal;

  const steps = new Set<number>();
  for (let q = 1; q < Math.min(bound, ANALYZE_SCAN_LIMIT); q++) steps.add(q);
  // A tier at 1 has no "one fewer" quantity to compare against.
  for (const t of enabled) if (t.minQuantity >= 2 && t.minQuantity <= bound) steps.add(t.minQuantity - 1);

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
      const finalUnit = priceTieredLine(unit, t.minQuantity, [t], currency).finalUnitPrice;
      if (finalUnit.lessThan(cost)) belowCost.push({ tierId: t.id, finalUnit });
    }
  }
  return { nonMonotonic, belowCost };
}
