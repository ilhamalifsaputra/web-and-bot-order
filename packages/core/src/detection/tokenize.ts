/**
 * Tokenization primitives for the Detection Engine.
 *
 * These operate on already-`normalize()`-d strings; they do not perform any
 * casing/separator/diacritic normalization themselves.
 */

const WHITESPACE = /\s+/g;

/**
 * Splits an already-normalized string on whitespace, filtering out any
 * empty entries.
 */
export function tokenize(normalized: string): string[] {
  return normalized.split(WHITESPACE).filter((token) => token.length > 0);
}

/**
 * Returns the normalized string with all whitespace removed, e.g. for the
 * despaced-key lookup ("pubg mobile" -> "pubgmobile").
 */
export function despace(normalized: string): string {
  return normalized.replace(WHITESPACE, "");
}
