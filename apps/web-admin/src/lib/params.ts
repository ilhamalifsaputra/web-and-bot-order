/**
 * Path-parameter parsing shared by the admin API routes.
 *
 * `Number(req.params.id)` turns "abc" into NaN, "1.5" into 1.5 and a huge
 * number into one Postgres' 32-bit `Int` column cannot hold — Prisma throws
 * on all of them and the request ends as a 500. Routes parse ids with
 * {@link parsePositiveId} and answer `null` with a 400 instead.
 */

/** Largest value a Postgres `Int` (int4) id column can hold. */
export const MAX_DB_ID = 2_147_483_647;

/**
 * Parse a path segment as a positive whole number written in plain decimal
 * digits (no sign, exponent, hex, whitespace or leading zero). Returns null
 * for anything else, including values above `max` (default: the int4
 * ceiling; pass `Number.MAX_SAFE_INTEGER` for Telegram ids).
 */
export function parsePositiveId(raw: unknown, opts: { max?: number } = {}): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  const max = opts.max ?? MAX_DB_ID;
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

/**
 * Read an optional whole-number query parameter. Absent or empty is
 * `fallback`; plain decimal digits (no sign, exponent, hex or fraction) are
 * clamped into `[min, max]`, so an oversized window stays bounded instead of
 * loading the whole table; anything else is `null`, which the route answers
 * with a 400 — `Number("abc")` would otherwise reach a query as NaN or an
 * Invalid Date and end as a Prisma 500.
 */
export function parseQueryInt(
  raw: unknown,
  opts: { fallback: number; min: number; max: number },
): number | null {
  if (raw === undefined || raw === "") return opts.fallback;
  if (typeof raw !== "string" || !/^\d{1,15}$/.test(raw)) return null;
  return Math.min(opts.max, Math.max(opts.min, Number(raw)));
}
