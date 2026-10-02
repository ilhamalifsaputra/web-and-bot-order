/**
 * Language-aware money DISPLAY — the one place that knows which separators a
 * buyer's language uses. Indonesian ("id", "id-ID", any `id*` code) groups
 * thousands with "." and writes decimals with ","; every other language code,
 * an unknown one, or none at all is the English style ("," thousands, "."
 * decimals). The same rule `canonicalProduct`'s exact price always used.
 *
 * Display only: these helpers never change a number. IDR is shown in whole
 * rupiah (half-up, exactly as `formatIdr`), USD with 2 decimals (half-up), and
 * {@link groupDecimalDigits} keeps every digit it is given. Pure, Decimal-based,
 * browser-safe (imports nothing but decimal.js).
 *
 * Not for crypto payables (`formatUsdt`, `formatUsdtAmount`, `formatPrice`):
 * those are copied into exchanges and stay "5.07 USDT" in every language.
 */
import { Decimal } from "./money";

export interface MoneySeparators {
  /** Thousands separator. */
  readonly group: string;
  /** Decimal separator. */
  readonly decimal: string;
}

const INDONESIAN: MoneySeparators = { group: ".", decimal: "," };
const ENGLISH: MoneySeparators = { group: ",", decimal: "." };

/** True for any `id*` language code, any case. Everything else is the English style. */
export function isIndonesianLanguage(lang: string | null | undefined): boolean {
  return (lang ?? "").toLowerCase().startsWith("id");
}

export function moneySeparators(lang: string | null | undefined): MoneySeparators {
  return isIndonesianLanguage(lang) ? INDONESIAN : ENGLISH;
}

/**
 * Localize a plain, unsigned decimal string ("1234567", "21000.1254", "8.10"):
 * group the whole part in threes and join the fraction with the language's
 * decimal separator. Every digit is kept, trailing zeros included.
 */
export function groupDecimalDigits(plain: string, lang: string | null | undefined): string {
  const { group, decimal } = moneySeparators(lang);
  const [whole = "0", fraction] = plain.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return fraction === undefined ? grouped : `${grouped}${decimal}${fraction}`;
}

/** Rupiah in whole rupiah (half-up): id "Rp4.480", en "Rp4,480"; negative "-Rp…". */
export function formatIdrFor(amount: Decimal.Value, lang: string | null | undefined): string {
  const whole = new Decimal(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return `${whole.isNegative() ? "-" : ""}Rp${groupDecimalDigits(whole.abs().toFixed(0), lang)}`;
}

/** US dollars with 2 decimals (half-up): id "$1.234,50", en "$1,234.50"; negative "-$…". */
export function formatUsdFor(amount: Decimal.Value, lang: string | null | undefined): string {
  const value = new Decimal(amount);
  const sign = value.isNegative() && !value.isZero() ? "-" : "";
  return `${sign}$${groupDecimalDigits(value.abs().toFixed(2, Decimal.ROUND_HALF_UP), lang)}`;
}

/** Up to 2 decimals, trailing zeros (and a bare decimal point) dropped: "1.64", "1.5", "2". */
function trimTwoDecimals(value: Decimal): string {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Short Rupiah for a button label: below 1,000 the full {@link formatIdrFor};
 * below a million the nearest whole thousand ("Rp4K"); from a million up the
 * millions with up to 2 decimals in the language's decimal separator
 * (id "Rp1,64M", en "Rp1.64M"). The K/M count is never grouped (as before).
 */
export function formatCompactIdrFor(amount: Decimal.Value, lang: string | null | undefined): string {
  const value = new Decimal(amount);
  if (value.lessThan(1000)) return formatIdrFor(value, lang);
  if (value.lessThan(1_000_000)) return `Rp${value.div(1000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)}K`;
  return `Rp${trimTwoDecimals(value.div(1_000_000)).replace(".", moneySeparators(lang).decimal)}M`;
}
