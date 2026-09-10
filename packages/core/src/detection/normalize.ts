/**
 * String normalization primitive for the Detection Engine.
 *
 * INV-2 (non-destructive): normalization may only change casing, whitespace,
 * separators, and unicode folding. It must NEVER delete a token, strip
 * digits, stem, or truncate a suffix.
 * INV-3 (total function): accepts unknown input and never throws; non-string
 * input coerces to "".
 */

// Separator characters that get collapsed to a single space, in addition to
// existing whitespace. Kept as a regex character class, not stripped.
const SEPARATOR_CHARS = /[-_.:]/g;

// Any run of whitespace (after separators have been mapped to spaces).
const WHITESPACE_RUN = /\s+/g;

// Unicode combining diacritical marks, produced by an NFKD decomposition
// (e.g. "é" -> "e" + U+0301 COMBINING ACUTE ACCENT).
const COMBINING_MARKS = /\p{Mn}/gu;

/**
 * Normalizes arbitrary input into a lowercase, whitespace-collapsed,
 * separator-collapsed, diacritic-folded, half-width string.
 *
 * Order of operations matters:
 * 1. Coerce non-string input to "".
 * 2. NFKC-normalize first, to fold full-width/compatibility characters
 *    (e.g. "Ａ" -> "A") to their standard forms. Doing this before the NFKD
 *    pass avoids NFKD interacting with NFKC-only mappings.
 * 3. NFKD-normalize and strip combining marks, to fold diacritics
 *    (e.g. "É" -> "E" -> "e").
 * 4. Lowercase.
 * 5. Map separator characters (-, _, ., :) to spaces.
 * 6. Collapse whitespace runs to a single space.
 * 7. Trim.
 */
export function normalize(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }

  return input
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(SEPARATOR_CHARS, " ")
    .replace(WHITESPACE_RUN, " ")
    .trim();
}
