/** Minutes from first dispatch at which each successive recheck attempt is
 * due. Attempt 0 = the original dispatch (not covered by this schedule —
 * this only covers RECHECKS, i.e. attempts >= 1). Front-loaded (+2m, +5m,
 * +15m, +30m, +1h) while Digiflazz is most likely to resolve quickly —
 * roughly the same cadence this repo's QRIS reconcile pollers already use
 * for "did the gateway update yet" — then falls back to a steady +2h
 * cadence once past the front-loaded steps, capped at a 24h total window
 * from first dispatch: beyond that this is almost certainly a genuinely
 * stuck/lost supplier order, not a slow one, and needs a human regardless.
 */
export const DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES = [2, 5, 15, 30, 60] as const;
export const DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES = 120;
export const DIGIFLAZZ_RECHECK_WINDOW_HOURS = 24;

/** Given the attempt number about to be made (1 = first recheck after the
 * original dispatch, 2 = second, ...) and the order's first-dispatch time,
 * returns the next recheck due-at Date, or null if that attempt would fall
 * beyond the 24h window (caller must mark the order terminally failed
 * instead of scheduling another recheck). */
export function nextDigiflazzRecheckAt(
  dispatchedAt: Date,
  attempt: number,
  now = new Date(),
): Date | null {
  const elapsedCap = new Date(dispatchedAt.getTime() + DIGIFLAZZ_RECHECK_WINDOW_HOURS * 3_600_000);
  const stepMinutes =
    attempt <= DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES.length
      ? DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES[attempt - 1]!
      : DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES.at(-1)! +
        (attempt - DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES.length) * DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES;
  const candidate = new Date(dispatchedAt.getTime() + stepMinutes * 60_000);
  if (candidate >= elapsedCap) return null; // window exhausted — caller marks terminal failed
  return candidate < now ? now : candidate; // never schedule in the past
}
