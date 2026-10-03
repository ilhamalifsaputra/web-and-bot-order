/**
 * Money and percent fields read from an admin request body BY THEIR SHAPE.
 *
 * An admin typing `10.000` means ten thousand rupiah; `new Decimal("10.000")`
 * reads ten. Every typed amount therefore goes through the shared
 * `parseMoneyInput` (packages/core/src/moneyFormat.ts), and a shape it cannot
 * read without guessing (`abc`, `1.2.3`, USDT `1.000`) comes back null so the
 * route answers 400 with {@link moneyFieldError}.
 *
 * A JSON number is not typed text: the JSON parser already fixed its value,
 * so it is taken as-is (finite only). Re-reading its digits by shape would
 * turn `1.234` into one thousand two hundred thirty-four.
 */
import { Decimal } from "@app/core/money";
import { parseMoneyInput, parsePercentInput } from "@app/core/moneyFormat";

export type MoneyFieldCurrency = "IDR" | "USDT";

/**
 * Read a body field as an amount. Strings are read by shape; finite JSON
 * numbers are taken at their value. With `signed`, one leading `+`, `-` or
 * `−` (U+2212) is allowed before the amount (wallet adjustments); otherwise a
 * negative amount is refused. Returns null for anything else.
 */
export function readMoneyField(
  value: unknown,
  currency: MoneyFieldCurrency = "IDR",
  opts: { signed?: boolean } = {},
): Decimal | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (!opts.signed && value < 0)) return null;
    return new Decimal(value);
  }
  if (typeof value !== "string") return null;
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

/** Read a body field as a percent (`10`, `10.5`, `10,5`); finite non-negative JSON numbers are taken as-is. */
export function readPercentField(value: unknown): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? new Decimal(value) : null;
  if (typeof value !== "string") return null;
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
