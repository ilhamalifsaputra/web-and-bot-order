/**
 * "2 hours ago" / "in 3 days" style relative-time formatting, localized via
 * Intl.RelativeTimeFormat using the page's current language (see i18n.ts's
 * currentLang()). Dependency-free — no date library needed for this ladder.
 */
import { currentLang } from "./i18n";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// ~10 months, in days — the ladder's cutover from weeks to months.
const TEN_MONTHS_DAYS = 304;
const MONTH = 30 * DAY;

/**
 * Format `iso` relative to `now` (default: Date.now()) using the largest
 * unit that fits: seconds (<45s), minutes (<45min), hours (<22h), days
 * (<26d), weeks (<~10 months), else months. Returns "" if `iso` doesn't
 * parse.
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const deltaMs = then - now;
  const absMs = Math.abs(deltaMs);
  const rtf = new Intl.RelativeTimeFormat(currentLang(), { numeric: "auto" });

  if (absMs < 45 * SECOND) {
    return rtf.format(Math.round(deltaMs / SECOND), "second");
  }
  if (absMs < 45 * MINUTE) {
    return rtf.format(Math.round(deltaMs / MINUTE), "minute");
  }
  if (absMs < 22 * HOUR) {
    return rtf.format(Math.round(deltaMs / HOUR), "hour");
  }
  if (absMs < 26 * DAY) {
    return rtf.format(Math.round(deltaMs / DAY), "day");
  }
  if (absMs < TEN_MONTHS_DAYS * DAY) {
    return rtf.format(Math.round(deltaMs / WEEK), "week");
  }
  return rtf.format(Math.round(deltaMs / MONTH), "month");
}
