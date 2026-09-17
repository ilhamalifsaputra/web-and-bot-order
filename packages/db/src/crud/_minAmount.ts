import { Decimal } from "@app/core/money";

/**
 * Settings keys for the six payment rails' own minimum accepted amount, each
 * denominated in the currency that rail actually settles in: Rupiah for the two
 * QRIS rails, USDT for the four crypto rails. Written by web-admin's Settings
 * page (apps/web-admin/src/routes/api/settings.ts, whose own labels read
 * "Minimum order total customers can pay via <rail>"), read by each rail's
 * config resolver below and — since M11 — ENFORCED as the per-method override
 * in crud/orderMinimums.ts.
 *
 * They live here, in the leaf module every rail file already imports
 * `parseMinAmount` from, rather than in the six rail files that own the rest of
 * each rail's config: `orderMinimums.ts` needs all six, and three of the rail
 * files (binance_internal, bybit_deposit, bybit_bsc_deposit) import
 * `pricing.ts`, which now imports `orderMinimums.ts` — reading the keys from
 * the rail files would close that loop into an import cycle. Each rail file
 * re-exports its own key so existing importers see no change.
 */
export const TOKOPAY_MIN_AMOUNT_KEY = "tokopay_min_amount";
export const PAYDISINI_MIN_AMOUNT_KEY = "paydisini_min_amount";
export const NOWPAYMENTS_MIN_AMOUNT_KEY = "nowpayments_min_amount";
export const BYBIT_MIN_AMOUNT_KEY = "bybit_min_amount";
export const BYBIT_BSC_MIN_AMOUNT_KEY = "bybit_bsc_min_amount";
export const BINANCE_INTERNAL_MIN_AMOUNT_KEY = "binance_internal_min_amount";

/**
 * Parse a `<method>_min_amount` Settings value into a Decimal for the
 * checkout "minimum payment" note. Blank, non-numeric, or non-positive
 * values all mean "no note" (`null`) — never throws, since the setting is
 * free-text in web-admin and only ever used for an informational display.
 */
export function parseMinAmount(raw: string | null): Decimal | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.greaterThan(0) ? d : null;
  } catch {
    return null; // free-text setting — an invalid value means "no note", not a crash
  }
}
