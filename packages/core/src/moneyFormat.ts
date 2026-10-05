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
 * The input-side helpers: {@link parseMoneyInput} reads an amount a buyer
 * typed back from either style by its shape, and {@link parsePercentInput}
 * reads a typed percent.
 */
import { Decimal } from "./money";
import { normalizeMoneyInput } from "./moneyInput";

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
  return `${whole.isNegative() && !whole.isZero() ? "-" : ""}Rp${groupDecimalDigits(whole.abs().toFixed(0), lang)}`;
}

/** US dollars with 2 decimals (half-up): id "$1.234,50", en "$1,234.50"; negative "-$…". */
export function formatUsdFor(amount: Decimal.Value, lang: string | null | undefined): string {
  const value = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
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
 * writes millions "jt" because "M" reads as miliar (billion) there. Rounded
 * boundaries promote units; billions use "M" (id) / "B" (en).
 */
export function formatCompactIdrFor(amount: Decimal.Value, lang: string | null | undefined): string {
  const value = new Decimal(amount);
  if (value.lessThan(1000)) return formatIdrFor(value, lang);
  const thousands = value.div(1000).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  if (thousands.lessThan(1000)) return `Rp${thousands.toFixed(0)}K`;
  const millions = value.div(1_000_000).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (millions.lessThan(1000)) return `Rp${trimTwoDecimals(millions).replace(".", moneySeparators(lang).decimal)}${isIndonesianLanguage(lang) ? "jt" : "M"}`;
  return `Rp${trimTwoDecimals(value.div(1_000_000_000)).replace(".", moneySeparators(lang).decimal)}${isIndonesianLanguage(lang) ? "M" : "B"}`;
}

/**
 * Read a money amount a buyer TYPED, by its shape alone — never by guessing the
 * buyer's language, and never by guessing an ambiguous shape (it returns null so
 * the caller re-prompts). Range checks (> 0, min, max) stay with the caller.
 *
 * The shape table (which spellings IDR and USDT accept, and why a single
 * separator + exactly 3 digits is ambiguous for USDT) lives in ONE place:
 * {@link normalizeMoneyInput} in `./moneyInput.ts`, dependency-free so the
 * storefront client can carry a byte-identical copy. This wraps its canonical
 * string in a Decimal.
 */
export function parseMoneyInput(raw: string, currency: "IDR" | "USDT"): Decimal | null {
  const s = normalizeMoneyInput(raw, currency);
  return s === null ? null : new Decimal(s);
}

/**
 * Read an amount a CLIENT already normalized — the canonical plain decimal
 * {@link normalizeMoneyInput} emits (`79000`, `5.5`, `12.123`): digits with no
 * leading zeros, optionally `.` and digits not ending in 0, at most 20
 * characters. This is the wire format of a form that reads the typed text by
 * shape in the browser and sends the result (the storefront top-up form), so
 * it is read exactly, never by shape again: re-reading the canonical USDT
 * `12.123` by shape would call it ambiguous. Anything else — typed spellings
 * (`10.000`, `1,5`), exponents (`1e3`), signs, spaces, non-strings — is null.
 * Range checks stay with the caller.
 */
export function readCanonicalMoney(value: unknown): Decimal | null {
  if (typeof value !== "string" || value.length > 20) return null;
  if (!/^(0|[1-9]\d*)(\.\d*[1-9])?$/.test(value)) return null;
  return new Decimal(value);
}

/**
 * A typed percent: digits with an optional `.`/`,` decimal part of 1-2 digits
 * (`10`, `10.5`, `10,5`). Anything else — `10.000`, `1e1`, signs, NaN — is null,
 * so the caller re-prompts instead of guessing. Range checks stay with the caller.
 * Shared by the order bot's admin conversations and the admin panel's routes.
 */
export function parsePercentInput(raw: string): Decimal | null {
  const text = raw.trim();
  if (!/^\d+([.,]\d{1,2})?$/.test(text)) return null;
  return new Decimal(text.replace(",", "."));
}
