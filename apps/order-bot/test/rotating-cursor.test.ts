import { describe, expect, it } from "vitest";
import { rotatingSlice, createRotatingCursor } from "../src/payments/rotatingCursor";

describe("rotatingSlice", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("returns every item, unchanged order, when the list already fits within count", () => {
    expect(rotatingSlice(items.slice(0, 3), 0, 5)).toEqual([0, 1, 2]);
    expect(rotatingSlice(items.slice(0, 3), 7, 5)).toEqual([0, 1, 2]); // start ignored once everything fits
  });

  it("takes count items starting at start when there's no wraparound", () => {
    expect(rotatingSlice(items, 0, 3)).toEqual([0, 1, 2]);
    expect(rotatingSlice(items, 3, 3)).toEqual([3, 4, 5]);
  });

  it("wraps around the end of the list back to the start", () => {
    expect(rotatingSlice(items, 8, 4)).toEqual([8, 9, 0, 1]);
  });

  it("normalizes a start past the list length via modulo, including negative values", () => {
    expect(rotatingSlice(items, 13, 3)).toEqual([3, 4, 5]); // 13 % 10 == 3
    expect(rotatingSlice(items, -1, 3)).toEqual([9, 0, 1]);
  });
});

describe("createRotatingCursor", () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("advances by the requested count on a normal (fully-attempted) cycle, covering the whole list over successive calls", () => {
    const cursor = createRotatingCursor();
    const seen = new Set<number>();
    for (let i = 0; i < 4; i++) {
      const batch = cursor.next(items, 3);
      batch.forEach((n) => seen.add(n));
      cursor.advance(batch.length);
    }
    expect(seen.size).toBe(items.length); // 4 cycles * 3 = 12 >= 10, full coverage
  });

  // The bug this module's own doc-comment fixes: bybitBscConfirmationTracker.ts
  // used to advance its cursor by the FULL window size unconditionally,
  // before the batch was iterated — so a mid-batch early return (e.g. a
  // rate-limit hit after only 1 of 3 items) still skipped the other 2 items
  // for a full rotation, instead of retrying them on the very next cycle.
  it("advancing by fewer than the batch size (an early return) retries the untouched remainder next cycle, not a full rotation later", () => {
    const cursor = createRotatingCursor();

    const firstBatch = cursor.next(items, 3);
    expect(firstBatch).toEqual([0, 1, 2]);
    // Simulate processing only the first item before an early return (e.g. a
    // rate-limit hit) — advance by 1, not by the full batch of 3.
    cursor.advance(1);

    const secondBatch = cursor.next(items, 3);
    // Items 1 and 2 (never actually attempted last cycle) are picked up again
    // immediately — the old bug would have advanced straight to [3, 4, 5]
    // here, silently skipping 1 and 2 until the rotation wrapped all the way
    // back around.
    expect(secondBatch).toEqual([1, 2, 3]);
  });

  it("advance(0) — a cycle that attempted nothing at all — retries the exact same window next cycle", () => {
    const cursor = createRotatingCursor();
    const firstBatch = cursor.next(items, 3);
    cursor.advance(0);
    expect(cursor.next(items, 3)).toEqual(firstBatch);
  });
});
