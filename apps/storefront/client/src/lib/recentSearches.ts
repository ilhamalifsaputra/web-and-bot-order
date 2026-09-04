/**
 * Client-only search history — the last few terms this browser searched for,
 * so a shopper who mistyped can re-run a query with one tap instead of
 * retyping it on a phone keyboard. Never sent anywhere.
 *
 * Extracted verbatim from the old `pages/SearchPage.tsx` (Task 12: that full
 * page became the `SearchOverlay`). The storage key is unchanged, so history
 * saved by the old page is still offered by the overlay.
 *
 * Every localStorage touch is wrapped: Safari in private mode throws on write
 * (and can throw on read), and a value left behind by an older build may not
 * parse. Remembering searches is a convenience; it must never be the reason a
 * render fails, so every failure degrades to "no history".
 */
export const RECENT_KEY = "storefront.recent_searches";
/** Short enough to stay a shortcut rather than a second navigation problem. */
export const RECENT_LIMIT = 5;

/** Read the stored history, newest first. Returns `[]` on any failure. */
export function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string" && v.trim() !== "")
      .slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function persistRecent(terms: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(terms));
  } catch {
    // The caller still holds the list in React state for this visit; losing it
    // on reload is the correct trade against failing the search.
  }
}

/**
 * Record `term` at the front of the history and return the new list. Matching
 * case-insensitively keeps "Netflix" and "netflix" from occupying two of the
 * five slots. A blank term is ignored (the current list is returned unchanged).
 */
export function pushRecent(term: string): string[] {
  const trimmed = term.trim();
  if (!trimmed) return readRecent();
  const next = [
    trimmed,
    ...readRecent().filter((v) => v.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, RECENT_LIMIT);
  persistRecent(next);
  return next;
}

/** Forget everything. Safe to call when storage is unavailable. */
export function clearRecent(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // Same reasoning as persistRecent — nothing here is worth an error screen.
  }
}
