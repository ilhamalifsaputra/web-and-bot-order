/**
 * The one rule set for a denomination's prices, shared by the admin catalog
 * API (create + update) and the catalog CSV import so the two can never drift.
 *
 * - `price` (what a buyer pays) must be finite and at least Rp1. A price of 0
 *   leaves an order with nothing to collect, and checkout then settles and
 *   DELIVERS it for free; a negative price offsets the other lines of a cart.
 *   Below Rp1 is refused too: a sub-rupiah sale price rounds to a free charge.
 * - `resellerPrice` is a sale price as well, so the same floor applies, and it
 *   must not be higher than `price` (a reseller never pays more than retail).
 * - `costPrice` is what the shop paid, never charged to anyone: 0 is allowed
 *   (goods with no purchase cost), negative or non-finite is not. It is not
 *   compared to `price`; selling below cost is the shop's own decision.
 *
 * Returns the English message to answer with (a 400 body / a CSV row error),
 * or null when the prices are acceptable.
 */
import { Decimal } from "./money";

export interface DenominationPrices {
  price: Decimal;
  costPrice?: Decimal | null;
  resellerPrice?: Decimal | null;
}

/** The lowest sale price a denomination may have, in rupiah. */
export const MIN_SALE_PRICE = new Decimal(1);

export function denominationPriceError(p: DenominationPrices): string | null {
  if (!p.price.isFinite() || p.price.lessThan(MIN_SALE_PRICE)) {
    return "Price must be at least Rp1.";
  }
  if (p.costPrice != null && (!p.costPrice.isFinite() || p.costPrice.isNegative())) {
    return "Cost price must be zero or more.";
  }
  if (p.resellerPrice != null) {
    if (!p.resellerPrice.isFinite() || p.resellerPrice.lessThan(MIN_SALE_PRICE)) {
      return "Reseller price must be at least Rp1.";
    }
    if (p.resellerPrice.greaterThan(p.price)) {
      return "Reseller price must not be higher than the price.";
    }
  }
  return null;
}
