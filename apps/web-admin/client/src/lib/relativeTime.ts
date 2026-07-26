/**
 * Human relative phrasing for a UTC ISO timestamp, for the Joined/Last Seen
 * columns — "Just now" / "N minutes ago" / "N hours ago" / "Yesterday" /
 * "N days ago", falling back to `display` (the shop-timezone-correct string
 * every route already sends as `*Display`, see dateDisplay.ts) once the gap
 * exceeds 30 days.
 *
 * Takes `display` as a required second argument rather than re-deriving an
 * absolute date from `iso` itself: computing a fallback date in the
 * client's local timezone would reintroduce the exact bug dateDisplay.ts's
 * server-side formatting exists to avoid. `display` is always already
 * correct.
 *
 * `now` is an injectable clock for tests; defaults to the real Date.now().
 * A future `iso` (clock skew / bad data) clamps to "Just now" rather than
 * showing a negative duration.
 */
export function formatRelativeTime(iso: string, display: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return display;
  const diffMs = Math.max(0, now.getTime() - then);
  const minute = 60_000, hour = 3_600_000, day = 86_400_000;

  if (diffMs < minute) return "Just now";
  if (diffMs < hour) {
    const m = Math.floor(diffMs / minute);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diffMs < day) {
    const h = Math.floor(diffMs / hour);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(diffMs / day);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return display;
}
