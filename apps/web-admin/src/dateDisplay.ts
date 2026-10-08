/**
 * Server-side date pre-formatting for the web-admin React SPA — mirrors
 * apps/storefront/src/pageData.ts's approach: format stored UTC Dates into
 * the shop's configured TIMEZONE here, so JSON routes send a display string
 * alongside the raw Date/ISO field, and client pages never call
 * `new Date(x).toLocaleString()` (which renders in the *browser's* timezone,
 * not the shop's).
 */
import { localize } from "@app/core/datetime";

/** "yyyy-LL-dd HH:mm" in config.TIMEZONE, or null for a null/undefined input. */
export function displayDateTime(d: Date | null | undefined): string | null {
  return d == null ? null : localize(d);
}

/**
 * Compact timestamp for dense UIs: "HH:mm" when `d` falls on the same calendar
 * day as `now` in config.TIMEZONE, otherwise "LLL d, HH:mm" (e.g. "Oct 7, 22:41").
 * Null for a null/undefined input. The full `displayDateTime` stays available for tooltips.
 */
export function displayShortDateTime(d: Date | null | undefined, now: Date = new Date()): string | null {
  if (d == null) return null;
  const sameDay = localize(d, "yyyy-LL-dd") === localize(now, "yyyy-LL-dd");
  return localize(d, sameDay ? "HH:mm" : "LLL d, HH:mm");
}

/** "yyyy-LL-dd" in config.TIMEZONE, or null for a null/undefined input. */
export function displayDate(d: Date | null | undefined): string | null {
  return d == null ? null : localize(d, "yyyy-LL-dd");
}
