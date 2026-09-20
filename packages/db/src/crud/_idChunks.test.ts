/**
 * `idChunks` — the id-list splitter every unbounded `IN (...)` filter in this
 * package now goes through (whole-branch review C2/C3).
 *
 * Pure and synchronous, so this file needs no database: what is worth pinning is
 * the two properties its callers depend on — that the chunks partition the input
 * exactly (no dropped or duplicated id, order preserved), and that an empty input
 * yields no chunk at all so a `for` loop over it issues zero queries rather than
 * one with an empty list.
 */
import { describe, it, expect } from "vitest";
import { idChunks, ID_CHUNK_SIZE } from "./_idChunks";

describe("idChunks", () => {
  it("yields no chunks for an empty list, so a caller's loop issues no query", () => {
    expect(idChunks([])).toEqual([]);
  });

  it("returns one chunk when the list fits", () => {
    expect(idChunks([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it("splits at the boundary without an empty trailing chunk", () => {
    expect(idChunks([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("puts the remainder in a final short chunk", () => {
    expect(idChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("partitions exactly — every id once, in order", () => {
    const ids = Array.from({ length: 997 }, (_, index) => index + 1);
    const chunks = idChunks(ids, 100);
    expect(chunks).toHaveLength(10);
    expect(chunks.flat()).toEqual(ids);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
  });

  it("defaults to a chunk size that leaves headroom under Postgres's 65535 bind-parameter cap", () => {
    expect(ID_CHUNK_SIZE).toBeLessThan(65_535);
    expect(idChunks(Array.from({ length: ID_CHUNK_SIZE + 1 }, (_, i) => i))).toHaveLength(2);
  });

  it("refuses a non-positive chunk size rather than looping forever", () => {
    expect(() => idChunks([1, 2, 3], 0)).toThrow(/positive chunk size/);
    expect(() => idChunks([1, 2, 3], -5)).toThrow(/positive chunk size/);
  });

  it("does not alias the input — mutating a chunk cannot corrupt the caller's list", () => {
    const ids = [1, 2, 3, 4];
    const chunks = idChunks(ids, 2);
    chunks[0]![0] = 99;
    expect(ids).toEqual([1, 2, 3, 4]);
  });
});
