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

/** "yyyy-LL-dd" in config.TIMEZONE, or null for a null/undefined input. */
export function displayDate(d: Date | null | undefined): string | null {
  return d == null ? null : localize(d, "yyyy-LL-dd");
}
