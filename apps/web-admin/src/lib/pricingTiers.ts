/**
 * The tier editor's wire format (GET/PUT /api/catalog/denominations/:id/pricing-tiers):
 * reading a submitted tier list and serializing the stored one.
 *
 * Every tier value is TYPED money, read by its shape (AGENTS.md "Typed money is
 * read by its shape"): a PERCENTAGE tier through `readPercentField` (`12,5` is
 * 12.5), a nominal tier (amount off per unit, or a fixed unit price) through
 * `readMoneyField` in rupiah (`10.000` is ten thousand). A tier lists its own
 * untouched pre-filled value in its `exact_fields`, so a re-save reads a stored
 * value exactly rather than by shape. A shape that cannot be read without
 * guessing is refused, never guessed; so is a value more precise than it is
 * stored with (a fractional rupiah, a percent with more than 2 decimals).
 *
 * Validation itself is the engine's (`validateTiers`); this file only maps its
 * findings to the row and field the admin has to fix, in Indonesian.
 */
import {
  TIER_DISCOUNT_TYPES,
  analyzeTiers,
  validateTiers,
  type PricingTier,
  type TierDiscountType,
  type TierValidationErrorCode,
} from "@app/core/bulk";
import { Decimal } from "@app/core/money";
import { tierValuePrecisionProblem, type TierInput } from "@app/db";
import { exactFields, readMoneyField, readPercentField } from "./moneyField";

export type TierField = "min_quantity" | "discount_type" | "discount_value";

export interface TierFieldError {
  index: number;
  field: TierField;
  message: string;
}

const FIELD_ORDER: readonly TierField[] = ["min_quantity", "discount_type", "discount_value"];

const FIELD_OF_CODE: Record<TierValidationErrorCode, TierField> = {
  INVALID_MIN_QUANTITY: "min_quantity",
  DUPLICATE_MIN_QUANTITY: "min_quantity",
  UNKNOWN_TYPE: "discount_type",
  INVALID_VALUE: "discount_value",
  INVALID_PERCENTAGE: "discount_value",
};

function messageFor(code: TierValidationErrorCode, minQuantity: number): string {
  switch (code) {
    case "INVALID_MIN_QUANTITY":
      return "Jumlah minimum harus bilangan bulat, paling sedikit 1.";
    case "DUPLICATE_MIN_QUANTITY":
      return `Ada lebih dari satu tier yang mulai dari jumlah ${minQuantity}, jadi harganya ambigu.`;
    case "UNKNOWN_TYPE":
      return "Jenis diskon tidak dikenal.";
    case "INVALID_VALUE":
      return "Nilai diskon harus lebih dari nol.";
    case "INVALID_PERCENTAGE":
      return "Diskon persen harus di atas 0 dan paling banyak 100.";
  }
}

const PERCENT_SHAPE_ERROR = "Diskon persen harus ditulis seperti 10, 10,5 atau 10.5.";
const MONEY_SHAPE_ERROR = "Nominal harus dalam rupiah, ditulis seperti 10000 atau 10.000.";
const MONEY_PRECISION_ERROR = "Nominal tier harus rupiah bulat, tanpa sen.";
const PERCENT_PRECISION_ERROR = "Diskon persen paling banyak 2 angka di belakang koma.";

/** The summary sentence a refused save answers with; the rows are in `tier_errors`. */
export const TIER_ERRORS_SUMMARY = "Beberapa tier belum valid. Perbaiki baris yang ditandai lalu simpan lagi.";

function readMinQuantity(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  return Number.NaN;
}

function isTierType(value: unknown): value is TierDiscountType {
  return typeof value === "string" && (TIER_DISCOUNT_TYPES as readonly string[]).includes(value);
}

/**
 * Read a submitted tier list. Returns the inputs for `saveTieredPricing`, or
 * every row-level problem (sorted by row, then field) when any tier is invalid.
 */
export function readTierInputs(raw: readonly unknown[]): { ok: true; tiers: TierInput[] } | { ok: false; errors: TierFieldError[] } {
  const errors: TierFieldError[] = [];
  const tiers: TierInput[] = [];
  const probe: PricingTier[] = [];
  raw.forEach((entry, index) => {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const minQuantity = readMinQuantity(row.min_quantity);
    const type = row.discount_type;
    const exact = exactFields(row).has("discount_value");
    let value: Decimal | null = null;
    if (isTierType(type)) {
      value =
        type === "PERCENTAGE"
          ? readPercentField(row.discount_value, { exact })
          : readMoneyField(row.discount_value, "IDR", { exact });
      if (value === null) {
        errors.push({ index, field: "discount_value", message: type === "PERCENTAGE" ? PERCENT_SHAPE_ERROR : MONEY_SHAPE_ERROR });
      } else if (tierValuePrecisionProblem(type, value) !== null) {
        // Refused rather than rounded, so the saved tier is exactly what was typed.
        errors.push({ index, field: "discount_value", message: type === "PERCENTAGE" ? PERCENT_PRECISION_ERROR : MONEY_PRECISION_ERROR });
      }
    }
    const isEnabled = row.is_enabled === undefined ? true : row.is_enabled === true;
    // An unreadable value is already reported above; probe with a stand-in so the engine reports the rest only.
    probe.push({
      id: String(index),
      minQuantity,
      discountType: type as TierDiscountType,
      discountValue: value ?? 1,
      isEnabled,
    });
    tiers.push({ minQuantity, discountType: String(type), discountValue: value ?? 0, isEnabled });
  });
  const result = validateTiers(probe);
  if (!result.ok) {
    for (const e of result.errors) {
      const index = Number(e.tierId);
      errors.push({ index, field: FIELD_OF_CODE[e.code], message: messageFor(e.code, probe[index]!.minQuantity) });
    }
  }
  if (errors.length > 0) {
    errors.sort((a, b) => a.index - b.index || FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field));
    return { ok: false, errors };
  }
  return { ok: true, tiers };
}

/** The editor's view of one denomination's tiered pricing, with the non-blocking warnings. */
export function serializeTierState(
  denomination: { price: Decimal.Value; costPrice: Decimal.Value | null },
  enabled: boolean,
  tiers: readonly PricingTier[],
) {
  const base = new Decimal(denomination.price);
  const cost = denomination.costPrice == null ? null : new Decimal(denomination.costPrice);
  const analysis = analyzeTiers({ effectiveUnit: base, costPrice: cost, tiers });
  const minQuantityOf = new Map(tiers.map((t) => [t.id, t.minQuantity]));
  return {
    enabled,
    tiers: tiers.map((t) => ({
      id: t.id,
      min_quantity: t.minQuantity,
      discount_type: t.discountType,
      discount_value: new Decimal(t.discountValue).toString(),
      is_enabled: t.isEnabled,
    })),
    base_unit_price: base.toString(),
    cost_price: cost?.toString() ?? null,
    analysis: {
      non_monotonic: analysis.nonMonotonic.map((w) => ({
        from_quantity: w.fromQuantity,
        to_quantity: w.toQuantity,
        from_total: w.fromTotal.toString(),
        to_total: w.toTotal.toString(),
      })),
      below_cost: analysis.belowCost.map((w) => ({
        tier_id: w.tierId,
        min_quantity: minQuantityOf.get(w.tierId) ?? null,
        final_unit_price: w.finalUnit.toString(),
      })),
    },
  };
}
