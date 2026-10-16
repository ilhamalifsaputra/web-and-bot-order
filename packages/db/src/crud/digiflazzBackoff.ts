/** Seconds from first dispatch at which each successive recheck attempt is
 * due. Attempt 0 = the original dispatch (not covered by this schedule —
 * this only covers RECHECKS, i.e. attempts >= 1).
 *
 * The Digiflazz webhook is the PRIMARY way an order's final status reaches
 * us; this schedule is only the safety net for a webhook that never arrives
 * (misconfigured secret, dropped delivery, our downtime). Digiflazz usually
 * resolves a top-up within seconds, so the schedule is aggressively
 * front-loaded (+10s, +30s, +1m, +2m, +5m, +15m, +30m, +1h) — a buyer whose
 * webhook was lost still sees their order complete within a minute or two,
 * not after a 2-minute-plus gap. Sub-minute steps are why this is expressed
 * in seconds. After the front-loaded steps it falls back to a steady +2h
 * cadence, capped at a 24h total window from first dispatch: beyond that
 * this is almost certainly a genuinely stuck/lost supplier order, not a slow
 * one, and needs a human regardless.
 */
export const DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS = [10, 30, 60, 120, 300, 900, 1800, 3600] as const;
/** Legacy minutes view of DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS, kept only so
 * any older importer still compiles. Derived — do not edit independently. */
export const DIGIFLAZZ_RECHECK_SCHEDULE_MINUTES = DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS.map((s) => s / 60);
export const DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES = 120;
export const DIGIFLAZZ_RECHECK_WINDOW_HOURS = 24;

/** Given the attempt number about to be made (1 = first recheck after the
 * original dispatch, 2 = second, ...) and the order's first-dispatch time,
 * returns the next recheck due-at Date, or null if that attempt would fall
 * beyond the 24h window (caller then moves the order to the still-locked
 * "unresolved_at_supplier" state and its slow schedule below — never to
 * failed, since the supplier may still complete it). */
export function nextDigiflazzRecheckAt(
  dispatchedAt: Date,
  attempt: number,
  now = new Date(),
): Date | null {
  const elapsedCap = new Date(dispatchedAt.getTime() + DIGIFLAZZ_RECHECK_WINDOW_HOURS * 3_600_000);
  const steps = DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS;
  const stepSeconds =
    attempt <= steps.length
      ? steps[attempt - 1]!
      : steps.at(-1)! + (attempt - steps.length) * DIGIFLAZZ_RECHECK_STEADY_INTERVAL_MINUTES * 60;
  const candidate = new Date(dispatchedAt.getTime() + stepSeconds * 1000);
  if (candidate >= elapsedCap) return null; // window exhausted — caller moves the order to unresolved_at_supplier
  return candidate < now ? now : candidate; // never schedule in the past
}

/** Slow cadence for an order still unresolved at the supplier after the 24h
 * window (backend audit A5): one status check every 6 hours... */
export const DIGIFLAZZ_UNRESOLVED_RECHECK_INTERVAL_HOURS = 6;
/** ...for at most 7 days after the first dispatch. After that the supplier is
 * no longer asked; the order stays locked and admins are reminded. */
export const DIGIFLAZZ_UNRESOLVED_WINDOW_DAYS = 7;
/** How often admins are reminded about an order that is still unresolved once
 * the 7-day window is over. */
export const DIGIFLAZZ_UNRESOLVED_REALERT_INTERVAL_HOURS = 24;

function unresolvedWindowEnd(dispatchedAt: Date): number {
  return dispatchedAt.getTime() + DIGIFLAZZ_UNRESOLVED_WINDOW_DAYS * 24 * 3_600_000;
}

/** Whether the 7-day slow-recheck window of an unresolved order is over. */
export function isDigiflazzUnresolvedWindowOver(dispatchedAt: Date, now = new Date()): boolean {
  return now.getTime() >= unresolvedWindowEnd(dispatchedAt);
}

/** When the next slow status check of an unresolved order is due: 6 hours
 * from `now`, capped at the end of the 7-day window, or null once that window
 * is over (the caller then stops asking the supplier and only reminds admins —
 * it never fails the order). */
export function nextDigiflazzUnresolvedRecheckAt(dispatchedAt: Date, now = new Date()): Date | null {
  const end = unresolvedWindowEnd(dispatchedAt);
  if (now.getTime() >= end) return null;
  return new Date(Math.min(now.getTime() + DIGIFLAZZ_UNRESOLVED_RECHECK_INTERVAL_HOURS * 3_600_000, end));
}
