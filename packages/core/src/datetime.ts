/**
 * Datetime helpers — luxon replacement for Python pytz/zoneinfo.
 * Store UTC, localize to config.TIMEZONE (Asia/Jakarta) only on display.
 * SQLite stores naive datetimes; treat values read back as UTC.
 */
import { DateTime } from "luxon";
import { config } from "./config";

/** Now, in UTC. */
export const utcNow = (): Date => new Date();

/** Treat a JS Date as UTC (SQLite strips tzinfo). */
export const ensureUtc = (d: Date): DateTime =>
  DateTime.fromJSDate(d, { zone: "utc" });

/** Format a stored UTC Date in the configured display timezone. */
export const localize = (
  d: Date | null | undefined,
  fmt = "yyyy-LL-dd HH:mm",
): string =>
  d == null
    ? "—"
    : DateTime.fromJSDate(d, { zone: "utc" }).setZone(config.TIMEZONE).toFormat(fmt);

/** "YYYY-MM-DD HH:MM:SS UTC" — matches Python now.strftime in outbox payloads. */
export const utcStamp = (d: Date): string =>
  DateTime.fromJSDate(d, { zone: "utc" }).toFormat("yyyy-LL-dd HH:mm:ss 'UTC'");

/** Add minutes to a Date, returning a new Date. */
export const addMinutes = (d: Date, minutes: number): Date =>
  new Date(d.getTime() + minutes * 60_000);

/** Add days to a Date, returning a new Date. */
export const addDays = (d: Date, days: number): Date =>
  new Date(d.getTime() + days * 86_400_000);

/**
 * Parse an admin-entered timestamp into a UTC Date. A bare wall-clock string
 * (what an `<input type="datetime-local">` submits, e.g. "2026-07-20T21:00") is
 * read in the shop's display timezone — the admin types the local time they see
 * everywhere else in the panel, so that is what it must mean. A string carrying
 * its own offset or "Z" is respected as given. Returns null when unparseable.
 */
export const parseShopLocal = (input: string, zone: string = config.TIMEZONE): Date | null => {
  const raw = input.trim();
  if (!raw) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const parsed = DateTime.fromISO(raw, hasOffset ? { setZone: true } : { zone });
  return parsed.isValid ? parsed.toUTC().toJSDate() : null;
};

/** Start of the calendar day in `zone` (default config.TIMEZONE), as a UTC Date. */
export const startOfDayUtc = (from: Date = new Date(), zone: string = config.TIMEZONE): Date =>
  DateTime.fromJSDate(from, { zone: "utc" }).setZone(zone).startOf("day").toUTC().toJSDate();

export { DateTime };
