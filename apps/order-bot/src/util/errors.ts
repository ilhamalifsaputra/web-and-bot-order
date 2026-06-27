/**
 * Error correlation helpers (feedback.md §8.6).
 *
 * A short, user-quotable ref (e.g. "AB12CD") ties an error shown to the user
 * (`error.generic_ref`) to its log line, so a customer report ("I got AB12CD")
 * maps straight to the stack trace. The global `bot.catch` in main.ts and the
 * handler-level catch blocks share this so the format is identical everywhere.
 */
import { logger } from "@app/core/logger";

/** A fresh correlation id — 6 uppercase hex chars. */
export function newErrorRef(): string {
  return Math.random().toString(16).slice(2, 8).toUpperCase();
}

/**
 * Log a caught error under a fresh ref and return the ref so the caller can
 * surface it to the user via `error.generic_ref`. Use this in handler-level
 * `catch` blocks where the failure is *hard* (an unexpected exception, e.g. a
 * DB error) — recoverable/expected states (a since-deleted product) should use
 * the lighter transient copy `error.try_again` instead, with no ref.
 */
export function logErrorRef(err: unknown, where: string, meta: Record<string, unknown> = {}): string {
  const ref = newErrorRef();
  logger.error({ err, ref, ...meta }, `${where} [ref=${ref}]`);
  return ref;
}
