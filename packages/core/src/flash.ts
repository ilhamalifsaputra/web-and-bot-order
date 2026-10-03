/**
 * Flash sale pricing — the single place that decides what one unit of a
 * denomination actually costs right now.
 *
 * A flash sale is a percent off the base price that applies for a bounded
 * window, stored on the denomination row itself (flashDiscountPercent /
 * flashStartsAt / flashEndsAt). Because every surface that shows or charges a
 * price already loads the whole denomination row, they can all call
 * `effectiveUnitPrice` without an extra query — the bot catalog, the storefront
 * grids/cart/checkout, and `createOrder*` in @app/db all share this function so
 * a buyer can never be shown one price and charged another.
 *
 * Layering rule: the flash price REPLACES the base price. Bulk pricing and
 * vouchers are computed on top of whatever this returns, exactly as they were
 * before flash sales existed.
 */
import { Decimal } from "./money";
import { quantizeMoney } from "./formatters";

/** The three columns that define a flash sale, as stored on Denomination. */
export type FlashFields = {
  flashDiscountPercent: Decimal.Value | null;
  flashStartsAt: Date | null;
  flashEndsAt: Date | null;
};

/** A denomination as far as pricing is concerned. */
export type PricedDenomination = FlashFields & {
  price: Decimal.Value;
  resellerPrice: Decimal.Value | null;
};

/**
 * A stored catalog price as whole Rupiah — the read-time half of the precision
 * contract every consumer of this module already assumes.
 *
 * `createDenomination`/`updateDenomination` (packages/db/src/crud/catalog.ts)
 * quantize `price`/`resellerPrice` to FOUR decimal places, deliberately wider
 * than the rail so an admin can type a markup-derived figure without it being
 * rounded under them at write time. But Rupiah has no fractional unit anywhere
 * downstream: `flashPrice` below rounds to 0dp, and `finalizeOrderPayment`'s IDR
 * branch rounds the order total to 0dp before any gateway sees it. So a row
 * holding 8900.37 — written through that 4dp path, or by hand against the
 * database — is a state every price consumer implicitly assumes cannot happen,
 * and the cheapest place to make that assumption true is here, at the one
 * function that decides what a unit costs.
 *
 * Half-up (quantizeMoney's own rule), not floor, for consistency with the two
 * roundings this figure meets downstream — `flashPrice`'s and
 * `finalizeOrderPayment`'s are both half-up, and a unit price rounded the other
 * way would drift against the total computed from it. The direction is not a
 * buyer-protection question at this scale: the gap is under one Rupiah, on a
 * figure that only has a fractional part because of a data-entry artifact.
 *
 * Deliberately NOT a write-time change: the 4dp column stays as it is (see
 * catalog.ts), exactly like `activeFlashPercent` re-validating
 * `flashDiscountPercent`'s bounds below rather than trusting the write-time
 * guard that already checks them.
 */
function wholeRupiah(price: Decimal.Value): Decimal {
  return quantizeMoney(price, 0);
}

/**
 * The percent off in effect at `now`, or null when this denomination has no
 * live flash sale. The window is half-open — [startsAt, endsAt) — so a sale
 * ending at 21:00 charges the base price again at exactly 21:00.
 *
 * Rejects a percent outside (0,100] rather than trusting the row: the same
 * "one misconfigured rule away from a free order" guard bulk pricing has at
 * write time (Pricing-4), repeated here so a row written before that guard
 * existed — or by hand against the shared database — still can't zero out a
 * price.
 */
export function activeFlashPercent(d: FlashFields, now: Date = new Date()): Decimal | null {
  if (d.flashDiscountPercent == null || d.flashStartsAt == null || d.flashEndsAt == null) {
    return null;
  }
  let percent: Decimal;
  try {
    percent = new Decimal(d.flashDiscountPercent);
  } catch {
    return null;
  }
  if (!percent.isFinite() || percent.lessThanOrEqualTo(0) || percent.greaterThan(100)) return null;
  if (now < d.flashStartsAt || now >= d.flashEndsAt) return null;
  return percent;
}

/** True when a flash sale is live for this denomination at `now`. */
export function isFlashActive(d: FlashFields, now: Date = new Date()): boolean {
  return activeFlashPercent(d, now) !== null;
}

/**
 * The base price with the live flash discount applied, or null when no flash
 * sale is running. Ignores resellerPrice — this is the "everyone" price, which
 * is what the strike-through UI compares against.
 */
export function flashPrice(d: PricedDenomination, now: Date = new Date()): Decimal | null {
  const percent = activeFlashPercent(d, now);
  if (percent === null) return null;
  // Whole rupiah, not 2dp: prices are central-IDR (plan.md §15), and the IDR
  // rail quantizes the order total to 0dp at pay time (finalizeOrderPayment).
  // A discounted line carrying sub-rupiah cents made the per-line figures on
  // screen and the amount actually charged disagree by up to a rupiah, with
  // formatIdr rounding each line independently so the gap was invisible.
  //
  // The percent comes off the WHOLE-Rupiah list price (see wholeRupiah above),
  // not the stored 4dp figure: the discount a buyer is promised is a percent off
  // the price they were shown, and rounding both ends the same way keeps one SKU
  // from having two defensible sale prices.
  return quantizeMoney(wholeRupiah(d.price).times(new Decimal(100).minus(percent)).div(100), 0);
}

/**
 * What one unit costs this buyer right now.
 *
 * Without a flash sale this is the rule every call site used before: resellers
 * pay resellerPrice when it is set, everyone else pays price — now read through
 * `wholeRupiah`, so the returned figure is always a whole Rupiah amount however
 * many decimals the row happens to carry. For every real catalog row (whole
 * Rupiah, as the admin UI and the Digiflazz importer both produce) that is
 * byte-identical to before.
 * With one running, a reseller pays whichever of resellerPrice and the flash
 * price is CHEAPER — so a flash sale can never raise a reseller's price, and
 * the two discounts never compound into a near-free order.
 */
export function effectiveUnitPrice(
  d: PricedDenomination,
  isReseller: boolean,
  now: Date = new Date(),
): Decimal {
  const base = wholeRupiah(
    isReseller && d.resellerPrice != null ? d.resellerPrice : d.price,
  );
  const flash = flashPrice(d, now);
  if (flash === null) return base;
  return Decimal.min(base, flash);
}
