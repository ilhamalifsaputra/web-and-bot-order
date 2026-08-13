/**
 * Rotating-window helper for a poller that must cap how many items one cycle
 * inspects without always favoring the same head-of-list items.
 *
 * Originally written for bybitBscConfirmationTracker.ts (Task 3 review
 * follow-up) and duplicated by hand into the three QRIS/IDR reconcile pollers
 * (Task 11 review follow-up, followup-review-fixes-2) — extracted here so all
 * four callers share one implementation instead of drifting apart.
 *
 * `rotatingSlice` alone is pure and safe to call directly. `createRotatingCursor`
 * additionally fixes a bug the tracker's own hand-rolled `cycleCursor` had:
 * advancing the cursor by the FULL window size before the batch was actually
 * iterated meant a mid-batch early return (e.g. a rate-limit hit) still
 * skipped the REST of that window on every later cycle — the cursor had
 * already moved past it. `advance(n)` here is instead called with however
 * many items THIS cycle actually got through, so an early return only skips
 * ahead by what was truly attempted, and the untouched remainder is picked up
 * at the very next cycle instead of after a full rotation back around.
 */

/** Return up to `count` items from `items`, starting at `start` and wrapping
 * around — a simple round-robin window so a capped-per-cycle scan still
 * covers every item over successive calls instead of always favoring the
 * same head-of-list entries. */
export function rotatingSlice<T>(items: readonly T[], start: number, count: number): T[] {
  if (items.length <= count) return [...items];
  const offset = ((start % items.length) + items.length) % items.length;
  const result: T[] = [];
  for (let i = 0; i < count; i++) result.push(items[(offset + i) % items.length]!);
  return result;
}

/** Module-per-rail cursor state: each poller that rotates its own list owns
 * one of these (never shared across rails — their rotations are independent
 * of one another). */
export interface RotatingCursor {
  /** Take up to `count` items from `items`, starting at this cursor's current position. */
  next<T>(items: readonly T[], count: number): T[];
  /** Advance the cursor by exactly how many items this cycle actually got
   * through (NOT necessarily the full batch size returned by `next` — see the
   * module doc-comment on why that distinction is the bug fix this exists
   * for). Safe to call with 0 (a cycle that attempted nothing this tick). */
  advance(by: number): void;
}

export function createRotatingCursor(): RotatingCursor {
  let cursor = 0;
  return {
    next<T>(items: readonly T[], count: number): T[] {
      return rotatingSlice(items, cursor, count);
    },
    advance(by: number): void {
      cursor += by;
    },
  };
}
