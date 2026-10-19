/** Browser DTO mirror: all normalization/pricing remains on the server. */
export type CanonicalMoney = { currency: "IDR"; amountMinor: string; scale: number } | { currency: "USD"; amountMinor: string; scale: 2 };
export type CanonicalVariant =
  | { type: "amount"; quantity: number; unit: string; residual: string[]; bonus?: { quantity: number; unit: string; label?: string } }
  | { type: "subscription" | "pass"; name: string; residual: string[]; duration?: { value: number; unit: "day" | "week" | "month" | "year" } }
  | { type: "package" | "bundle" | "voucher" | "unknown"; name: string; residual: string[] };
export interface CanonicalProduct {
  id: number; supplierSku: string | null; rawName: string; rawNameProvenance: "supplier" | "legacy_name";
  displayName: string; variant: CanonicalVariant; qualifiers: string[];
  product: { id: number; name: string; gameVariant: string | null; gameRegion: string | null };
  category: { id: number; name: string; group: string | null };
  priceIDR: CanonicalMoney; displayPrice: CanonicalMoney; formattedPrice: string; currencyFallback: boolean;
  conversion: { basis: "USDT"; direction: "IDR_PER_USDT"; rate: string; rounding: "CEIL_2DP"; source: "settings:usd_idr_rate" | "config:USDT_IDR_RATE" | "caller"; asOf: string | null } | null;
  availability: { status: "available" | "inactive" | "out_of_stock"; purchasable: boolean };
  createdAt: string | null; generatedAt: string;
}

/** Standalone purchase summaries include the parent without repeating an identical variant. */
export function canonicalPurchaseName(value: CanonicalProduct): string {
  return [
    ...(value.product.name === value.displayName ? [] : [value.product.name]),
    value.displayName,
    ...value.qualifiers,
  ].join(" · ");
}
