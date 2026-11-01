/** An `Idempotency-Key` header, trimmed and length-capped — a repeat header
 * takes the first value. Empty/oversized values are treated as "no key"
 * (opt out) rather than rejected, since this is additive and must never turn
 * a missing/malformed header into a hard failure. */
export function normalizeIdempotencyKey(header: string | string[] | undefined): string | null {
  const raw = (Array.isArray(header) ? header[0] : header) ?? "";
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 255 ? trimmed : null;
}
