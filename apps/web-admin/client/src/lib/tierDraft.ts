/**
 * The tier editor's draft rows (components/catalog/TieredPricingCard.tsx): reading what the admin typed,
 * validating it inline, previewing prices and building the PUT body.
 *
 * Prices are previewed with `./tierPricing.ts` — a byte-identical copy of the server's engine
 * (packages/core/src/tierPricing.ts) — so the editor shows the figure checkout will charge. Typed values are read
 * the way the server reads them (apps/web-admin/src/lib/pricingTiers.ts): a percent like `10`, `10,5` or `10.5`;
 * a rupiah amount by its shape through `./moneyInput.ts` (a copy of the server's reader), so `10.000` previews as
 * ten thousand. A value still holding the exact text the server sent is read as that plain decimal and named in
 * the tier's `exact_fields`, so a re-save never re-reads a stored `100.123` as 100123.
 */
import Decimal from "decimal.js";
import { normalizeMoneyInput } from "./moneyInput";
import { priceTieredLine, type PricingTier, type TierDiscountType, type TieredPrice } from "./tierPricing";

/** One stored tier as GET/PUT /api/catalog/denominations/:id/pricing-tiers send it. */
export interface StoredTier {
  id: string;
  min_quantity: number;
  discount_type: TierDiscountType;
  discount_value: string;
  is_enabled: boolean;
}

export interface TierState {
  enabled: boolean;
  tiers: StoredTier[];
  base_unit_price: string;
  cost_price: string | null;
  analysis: {
    non_monotonic: { from_quantity: number; to_quantity: number; from_total: string; to_total: string }[];
    below_cost: { tier_id: string; min_quantity: number | null; final_unit_price: string }[];
  };
}

export interface TierDraft {
  /** Stable React key for the row (never the array index). */
  key: string;
  minQuantity: string;
  discountType: TierDiscountType;
  value: string;
  isEnabled: boolean;
  /** The type and value the server sent for this row, while the row came from the server. */
  prefill: { discountType: TierDiscountType; value: string } | null;
}

export interface TierRowErrors {
  minQuantity?: string;
  value?: string;
}

let draftCounter = 0;
function nextKey(): string {
  draftCounter += 1;
  return `tier-${draftCounter}`;
}

export function draftsFromTiers(tiers: readonly StoredTier[]): TierDraft[] {
  return [...tiers]
    .sort((a, b) => a.min_quantity - b.min_quantity)
    .map((t) => ({
      key: nextKey(),
      minQuantity: String(t.min_quantity),
      discountType: t.discount_type,
      value: t.discount_value,
      isEnabled: t.is_enabled,
      prefill: { discountType: t.discount_type, value: t.discount_value },
    }));
}

/** A new empty row, starting one above the highest threshold so far (2 for the first one). */
export function blankDraft(drafts: readonly TierDraft[]): TierDraft {
  const highest = Math.max(1, ...drafts.map((d) => Number(d.minQuantity)).filter((n) => Number.isInteger(n)));
  return { key: nextKey(), minQuantity: String(highest + 1), discountType: "PERCENTAGE", value: "", isEnabled: true, prefill: null };
}

const PLAIN_DECIMAL = /^\d{1,30}(\.\d{1,30})?$/;

/** True when the row's value is still the exact text the server sent (same type), so it is sent as exact. */
export function isExactValue(d: TierDraft): boolean {
  return d.prefill !== null && d.prefill.discountType === d.discountType && d.value.trim() === d.prefill.value;
}

/** The row's value as the server will read it, or null when the server would refuse its shape. */
export function readDraftValue(d: TierDraft): Decimal | null {
  const text = d.value.trim();
  if (isExactValue(d)) return PLAIN_DECIMAL.test(text) ? new Decimal(text) : null;
  if (d.discountType === "PERCENTAGE") {
    // Same rule as parsePercentInput (packages/core/src/moneyFormat.ts).
    return /^\d+([.,]\d{1,2})?$/.test(text) ? new Decimal(text.replace(",", ".")) : null;
  }
  const plain = normalizeMoneyInput(text, "IDR");
  return plain === null ? null : new Decimal(plain);
}

function readMinQuantity(d: TierDraft): number | null {
  const text = d.minQuantity.trim();
  if (!/^\d{1,9}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 ? n : null;
}

/**
 * Inline errors per row key: a threshold that is not a whole number >= 1, a threshold already used, rows out of
 * ascending order, and a value the server would refuse (unreadable, zero, or a percent over 100).
 */
export function validateDrafts(drafts: readonly TierDraft[]): Record<string, TierRowErrors> {
  const errors: Record<string, TierRowErrors> = {};
  const seen = new Set<number>();
  let previous: number | null = null;
  for (const d of drafts) {
    const rowErrors: TierRowErrors = {};
    const min = readMinQuantity(d);
    if (min === null) rowErrors.minQuantity = "Jumlah minimum harus bilangan bulat, paling sedikit 1.";
    else if (seen.has(min)) rowErrors.minQuantity = `Jumlah ${min} sudah dipakai tier lain.`;
    else if (previous !== null && min < previous) rowErrors.minQuantity = `Urutkan dari jumlah terkecil: isi lebih dari ${previous}.`;
    if (min !== null) {
      seen.add(min);
      previous = previous === null ? min : Math.max(previous, min);
    }
    const value = readDraftValue(d);
    if (value === null) {
      rowErrors.value =
        d.discountType === "PERCENTAGE"
          ? "Tulis persen seperti 10, 10,5 atau 10.5."
          : "Tulis nominal rupiah seperti 10000, 10.000 atau 10000,50.";
    } else if (value.lessThanOrEqualTo(0)) {
      rowErrors.value = "Nilai harus lebih dari nol.";
    } else if (d.discountType === "PERCENTAGE" && value.greaterThan(100)) {
      rowErrors.value = "Persen paling banyak 100.";
    }
    if (rowErrors.minQuantity || rowErrors.value) errors[d.key] = rowErrors;
  }
  return errors;
}

/** The engine's view of the drafts — only meaningful once validateDrafts found nothing. */
export function tiersOfDrafts(drafts: readonly TierDraft[]): PricingTier[] {
  return drafts.map((d) => ({
    id: d.key,
    minQuantity: Number(d.minQuantity.trim()),
    discountType: d.discountType,
    discountValue: readDraftValue(d) ?? 0,
    isEnabled: d.isEnabled,
  }));
}

/** The unit price one tier gives at its own threshold. */
export function tierUnitPrice(base: Decimal, tier: PricingTier): Decimal {
  return priceTieredLine(base, tier.minQuantity, [tier], "IDR").finalUnitPrice;
}

/** Price `quantity` units — with the tiers while tiered pricing is on, at the base price while it is off. */
export function simulate(base: Decimal, quantity: number, tiers: readonly PricingTier[], enabled: boolean): TieredPrice {
  return priceTieredLine(base, quantity, enabled ? tiers : [], "IDR");
}

/** The PUT body: typed text as typed, untouched pre-fills named in each tier's exact_fields. */
export function tierPayload(enabled: boolean, drafts: readonly TierDraft[]) {
  return {
    enabled,
    tiers: drafts.map((d) => ({
      min_quantity: Number(d.minQuantity.trim()),
      discount_type: d.discountType,
      discount_value: d.value.trim(),
      is_enabled: d.isEnabled,
      ...(isExactValue(d) ? { exact_fields: ["discount_value"] } : {}),
    })),
  };
}
