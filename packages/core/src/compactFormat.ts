import { Decimal } from "./money";
import { formatIdr } from "./formatters";
import { formatCompactIdrFor } from "./moneyFormat";

function trimDecimal(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Compact quantity abbreviation for a denomination's numeric amount:
 * <1000 as-is; ≥1000 ÷1000 (up to 2dp, trailing zeros trimmed) + "K";
 * ≥1,000,000 ÷1,000,000 same pattern + "M".
 */
export function formatCompactQty(n: number): string {
  if (n < 1000) return String(Math.trunc(n));
  const [divisor, suffix] = n >= 1_000_000 ? [1_000_000, "M"] : [1000, "K"];
  return `${trimDecimal(new Decimal(n).div(divisor))}${suffix}`;
}

/**
 * Compact IDR price abbreviation without a reader language (the long-standing
 * output, byte-identical): <1000 via formatIdr; ≥1000 and <1,000,000 rounded
 * to the NEAREST WHOLE K (no decimals); ≥1,000,000 ÷1,000,000 (up to 2dp,
 * trimmed, "." decimal) + "M". Screens that know the buyer's language use
 * `formatCompactIdrFor(amount, lang)` from `./moneyFormat`.
 */
export function formatCompactPrice(amount: Decimal.Value): string {
  const dec = new Decimal(amount);
  if (dec.lessThan(1000)) return formatIdr(dec);
  return formatCompactIdrFor(dec, "en");
}
