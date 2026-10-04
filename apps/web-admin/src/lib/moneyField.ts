/**
 * Money and percent fields read from an admin request body BY THEIR SHAPE.
 *
 * An admin typing `10.000` means ten thousand rupiah; `new Decimal("10.000")`
 * reads ten. Every typed amount therefore goes through the shared
 * `parseMoneyInput` (packages/core/src/moneyFormat.ts), and a shape it cannot
 * read without guessing (`abc`, `1.2.3`, USDT `1.000`) comes back null so the
 * route answers 400 with {@link moneyFieldError}.
 *
 * Machine-formatted values are NOT typed text and are never shape-read:
 *  - A JSON number: the JSON parser already fixed its value, so it is taken
 *    as-is (finite only). Re-reading its digits by shape would turn `1.234`
 *    into one thousand two hundred thirty-four.
 *  - A field the client lists in `exact_fields` ({@link exactFields}): the
 *    edit forms pre-fill money inputs with the server's own Decimal strings
 *    (`100.123`), and a field still holding that untouched value is sent with
 *    its name in `exact_fields`. Such a field is read as a plain dot-decimal
 *    (`exact: true`) so an edit + re-save stores the same value; anything that
 *    is not a plain dot-decimal is refused. A field the admin retyped is left
 *    out of the list and read by shape as usual.
 */
import { Decimal } from "@app/core/money";
import { parseMoneyInput, parsePercentInput } from "@app/core/moneyFormat";

export type MoneyFieldCurrency = "IDR" | "USDT";

/** A plain dot-decimal as Decimal's own toString prints it: digits, optionally "." and digits. */
const PLAIN_DECIMAL = /^\d{1,30}(\.\d{1,30})?$/;

/**
 * The names a request body lists in `exact_fields` — the fields whose value is
 * a machine-formatted plain dot-decimal (pre-filled from the server and left
 * untouched), not text a person typed. Anything malformed yields an empty set,
 * so every field falls back to being read by shape.
 */
export function exactFields(body: unknown): ReadonlySet<string> {
  const list = body && typeof body === "object" ? (body as Record<string, unknown>).exact_fields : undefined;
  return new Set(Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : []);
}

/**
 * Read a body field as an amount. Strings are read by shape, or as a plain
 * dot-decimal with `exact` (see the module doc); finite JSON numbers are taken
 * at their value. With `signed`, one leading `+`, `-` or `−` (U+2212) is
 * allowed before the amount (wallet adjustments); otherwise a negative amount
 * is refused. Returns null for anything else.
 */
export function readMoneyField(
  value: unknown,
  currency: MoneyFieldCurrency = "IDR",
  opts: { signed?: boolean; exact?: boolean } = {},
): Decimal | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (!opts.signed && value < 0)) return null;
    return new Decimal(value);
  }
  if (typeof value !== "string") return null;
  if (opts.exact) {
    const text = value.trim();
    const negative = opts.signed === true && text.startsWith("-");
    const digits = negative ? text.slice(1) : text;
    if (!PLAIN_DECIMAL.test(digits)) return null;
    const amount = new Decimal(digits);
    return negative ? amount.negated() : amount;
  }
  let text = value.trim();
  let negative = false;
  if (opts.signed && /^[+\-−]/.test(text)) {
    negative = text[0] !== "+";
    text = text.slice(1).trimStart();
  }
  const amount = parseMoneyInput(text, currency);
  if (amount === null) return null;
  return negative ? amount.negated() : amount;
}

/**
 * Read a body field as a percent (`10`, `10.5`, `10,5`), or as a plain
 * dot-decimal of any precision with `exact`; finite non-negative JSON numbers
 * are taken as-is.
 */
export function readPercentField(value: unknown, opts: { exact?: boolean } = {}): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? new Decimal(value) : null;
  if (typeof value !== "string") return null;
  if (opts.exact) {
    const text = value.trim();
    return PLAIN_DECIMAL.test(text) ? new Decimal(text) : null;
  }
  return parsePercentInput(value);
}

/** The 400 message for an amount {@link readMoneyField} refused, naming the field and the spellings it accepts. */
export function moneyFieldError(label: string, currency: MoneyFieldCurrency = "IDR"): string {
  return currency === "IDR"
    ? `${label} must be an amount in rupiah, written like 10000, 10.000 or 10000,50.`
    : `${label} must be an amount written like 5, 5.07 or 1,000.50 — a single separator before exactly three digits (1.000) is ambiguous, so write 1000 or 1,000.00.`;
}

/** The 400 message for a percent {@link readPercentField} refused. */
export function percentFieldError(label: string): string {
  return `${label} must be a percent written like 10, 10.5 or 10,5.`;
}
