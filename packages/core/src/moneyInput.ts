/**
 * The one table that reads a money amount someone TYPED, shared by the order bot and admin server (through
 * `parseMoneyInput` in `packages/core/src/moneyFormat.ts`, which wraps the result in a Decimal) and the storefront
 * wallet top-up form.
 *
 * Dependency-free and browser-safe on purpose. The storefront client must not import `@app/core`
 * (scripts/check-frontend-boundaries.ts), so `apps/storefront/client/src/lib/moneyInput.ts` is a byte-identical
 * COPY of this file; `packages/core/src/moneyInput.test.ts` fails when the two differ. Edit this file, then copy
 * it over.
 */

/** Drop every group separator, then turn the decimal separator (if any) into ".". */
const ungroup = (group: string, decimal?: string) => (s: string): string => {
  const ungrouped = s.split(group).join("");
  return decimal ? ungrouped.replace(decimal, ".") : ungrouped;
};
const asIs = (s: string): string => s;

type ShapeRule = readonly [RegExp, (s: string) => string];

const IDR_SHAPES: readonly ShapeRule[] = [
  [/^\d+$/, asIs],
  [/^\d{1,3}(\.\d{3})+$/, ungroup(".")],
  [/^\d{1,3}(,\d{3})+$/, ungroup(",")],
  [/^\d+\.\d{1,2}$/, asIs],
  [/^\d+,\d{1,2}$/, ungroup(".", ",")],
  [/^\d{1,3}(\.\d{3})+,\d{1,2}$/, ungroup(".", ",")],
  [/^\d{1,3}(,\d{3})+\.\d{1,2}$/, ungroup(",")],
];

const USDT_SHAPES: readonly ShapeRule[] = [
  [/^\d+$/, asIs],
  // A single separator + exactly 3 digits is decimal-or-thousands: ambiguous, never matched.
  [/^\d+\.(\d{1,2}|\d{4,8})$/, asIs],
  [/^\d+,(\d{1,2}|\d{4,8})$/, ungroup(".", ",")],
  [/^\d{1,3}(,\d{3})+\.\d{1,8}$/, ungroup(",")],
  [/^\d{1,3}(\.\d{3})+,\d{1,8}$/, ungroup(".", ",")],
  [/^\d{1,3}(,\d{3}){2,}$/, ungroup(",")],
  [/^\d{1,3}(\.\d{3}){2,}$/, ungroup(".")],
];

/** "0079000" -> "79000", "10000.50" -> "10000.5", "1.0000" -> "1": same value, one spelling. */
function canonical(plain: string): string {
  const [whole = "", fraction = ""] = plain.split(".");
  const digits = whole.replace(/^0+(?=\d)/, "");
  const tail = fraction.replace(/0+$/, "");
  return tail ? `${digits}.${tail}` : digits;
}

/**
 * Read a money amount someone TYPED, by its shape alone — never by guessing the typist's language, and never by
 * guessing an ambiguous shape (it returns null so the caller re-prompts). Range checks (> 0, min, max) stay with
 * the caller.
 *
 * Returns the amount as a canonical plain decimal string — digits, then optionally "." and digits, no leading
 * zeros, no trailing fraction zeros, never exponent form ("79000", "5.5", "10000.5") — or null.
 *
 * Common to both: trimmed, at most 20 characters, digits plus `.`/`,` only (no spaces, signs, letters or
 * "Rp"/"$"), else null. Plain digits are an integer.
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
export function normalizeMoneyInput(raw: string, currency: "IDR" | "USDT"): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 20 || !/^[\d.,]+$/.test(text)) return null;
  const shapes = currency === "IDR" ? IDR_SHAPES : USDT_SHAPES;
  for (const [shape, toPlain] of shapes) {
    if (shape.test(text)) return canonical(toPlain(text));
  }
  return null;
}
