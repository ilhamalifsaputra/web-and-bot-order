import { Decimal } from "@app/core/money";

/**
 * Parse a `<method>_min_amount` Settings value into a Decimal for the
 * checkout "minimum payment" note. Blank, non-numeric, or non-positive
 * values all mean "no note" (`null`) — never throws, since the setting is
 * free-text in web-admin and only ever used for an informational display.
 */
export function parseMinAmount(raw: string | null): Decimal | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const d = new Decimal(v);
    return d.isFinite() && d.greaterThan(0) ? d : null;
  } catch {
    return null; // free-text setting — an invalid value means "no note", not a crash
  }
}
