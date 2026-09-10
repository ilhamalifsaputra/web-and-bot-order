/**
 * Tokenization primitives for the Detection Engine.
 *
 * These operate on already-`normalize()`-d strings; they do not perform any
 * casing/separator/diacritic normalization themselves.
 * INV-3 (total function): both exports accept unknown input and never throw;
 * non-string input coerces to "" / [].
 */

const WHITESPACE = /\s+/g;

/**
 * Splits an already-normalized string on whitespace, filtering out any
 * empty entries.
 */
export function tokenize(normalized: unknown): string[] {
  if (typeof normalized !== "string") {
    return [];
  }

  return normalized.split(WHITESPACE).filter((token) => token.length > 0);
}

/**
 * Returns the normalized string with all whitespace removed, e.g. for the
 * despaced-key lookup ("pubg mobile" -> "pubgmobile").
 */
export function despace(normalized: unknown): string {
  if (typeof normalized !== "string") {
    return "";
  }

  return normalized.replace(WHITESPACE, "");
}
