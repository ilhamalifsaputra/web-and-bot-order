/**
 * Money helpers — decimal.js replacement for Python `decimal.Decimal`.
 * All monetary values use 4 decimal places (Numeric(12,4)). NEVER convert to
 * `number` for arithmetic. Prisma returns Decimal instances directly.
 */
import Decimal from "decimal.js";

/** Quantize to 4 decimal places (matches Numeric(12,4)). */
export const money = (v: Decimal.Value): Decimal =>
  new Decimal(v).toDecimalPlaces(4);

/** "0.0000"-style fixed display; null → em dash. */
export const fmtMoney = (v: Decimal.Value | null | undefined): string =>
  v == null ? "—" : new Decimal(v).toDecimalPlaces(4).toString();

/** Compare two money values for exact equality after quantizing. */
export const moneyEq = (a: Decimal.Value, b: Decimal.Value): boolean =>
  money(a).equals(money(b));

export const ZERO = new Decimal(0);

export { Decimal };
