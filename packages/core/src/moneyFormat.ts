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
 *
 * The one input-side helper, {@link parseMoneyInput}, reads an amount a buyer
 * typed back from either style by its shape.
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
 * (id "Rp1,64jt", en "Rp1.64M"). The K/M/jt count is never grouped. Indonesian
 * writes millions "jt" because a bare "M" reads as miliar (billion) there.
 */
export function formatCompactIdrFor(amount: Decimal.Value, lang: string | null | undefined): string {
  const value = new Decimal(amount);
  if (value.lessThan(1000)) return formatIdrFor(value, lang);
  if (value.lessThan(1_000_000)) return `Rp${value.div(1000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0)}K`;
  return `Rp${trimTwoDecimals(value.div(1_000_000)).replace(".", moneySeparators(lang).decimal)}${isIndonesianLanguage(lang) ? "jt" : "M"}`;
}

/** Drop every group separator, then turn the decimal separator (if any) into ".". */
const normalize = (group: string, decimal?: string) => (s: string) => {
  const ungrouped = s.split(group).join("");
  return decimal ? ungrouped.replace(decimal, ".") : ungrouped;
};
const asIs = (s: string) => s;

type ShapeRule = readonly [RegExp, (s: string) => string];

const IDR_SHAPES: readonly ShapeRule[] = [
  [/^\d+$/, asIs],
  [/^\d{1,3}(\.\d{3})+$/, normalize(".")],
  [/^\d{1,3}(,\d{3})+$/, normalize(",")],
  [/^\d+\.\d{1,2}$/, asIs],
  [/^\d+,\d{1,2}$/, normalize(".", ",")],
  [/^\d{1,3}(\.\d{3})+,\d{1,2}$/, normalize(".", ",")],
  [/^\d{1,3}(,\d{3})+\.\d{1,2}$/, normalize(",")],
];

const USDT_SHAPES: readonly ShapeRule[] = [
  [/^\d+$/, asIs],
  // A single separator + exactly 3 digits is decimal-or-thousands: ambiguous, never matched.
  [/^\d+\.(\d{1,2}|\d{4,8})$/, asIs],
  [/^\d+,(\d{1,2}|\d{4,8})$/, normalize(".", ",")],
  [/^\d{1,3}(,\d{3})+\.\d{1,8}$/, normalize(",")],
  [/^\d{1,3}(\.\d{3})+,\d{1,8}$/, normalize(".", ",")],
  [/^\d{1,3}(,\d{3}){2,}$/, normalize(",")],
  [/^\d{1,3}(\.\d{3}){2,}$/, normalize(".")],
];

/**
 * Read a money amount a buyer TYPED, by its shape alone — never by guessing the
 * buyer's language, and never by guessing an ambiguous shape (it returns null so
 * the caller re-prompts). Range checks (> 0, min, max) stay with the caller.
 *
 * Common to both: trimmed, at most 20 characters, digits plus `.`/`,` only (no
 * spaces, signs, letters or "Rp"/"$"), else null. Plain digits are an integer.
 *
 * IDR (whole rupiah, so "sep + exactly 3 digits" is thousands grouping):
 * - `10.000`, `1,000,000`  grouped integer, ONE separator kind throughout
 * - `10000.5`, `10000,50`  one separator + 1-2 digits: that is the decimal point
 * - `1.000.000,50` (id), `1,000,000.50` (en)  grouped + 1-2 decimal digits
 * - anything else (`1.2.3`, `1,0000`, `.5`, `5.`, mixed) -> null
 *
 * USDT (displayed "5.07 USDT" in every language, so "." stays the decimal point):
 * - `5.5`, `5.07`, `1.0000`  one "." + 1-2 or 4-8 digits: decimal
 * - `5,5`, `12,3456`         one "," + 1-2 or 4-8 digits: decimal comma
 * - `1.000`, `1,000`         one separator + exactly 3 digits: ambiguous -> null
 * - `1,000,000.50` (en), `1.000.000,50` (id)  grouped + 1-8 decimal digits
 * - `1,000,000`, `1.000.000`  2+ groups, no tail: integer
 * - anything else -> null
 */
export function parseMoneyInput(raw: string, currency: "IDR" | "USDT"): Decimal | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 20 || !/^[\d.,]+$/.test(text)) return null;
  const shapes = currency === "IDR" ? IDR_SHAPES : USDT_SHAPES;
  for (const [shape, toPlain] of shapes) {
    if (shape.test(text)) return new Decimal(toPlain(text));
  }
  return null;
}
