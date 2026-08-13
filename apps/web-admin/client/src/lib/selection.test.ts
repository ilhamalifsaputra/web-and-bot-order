import { describe, it, expect } from "vitest";
import { visibleSelection } from "./selection";

interface Row {
  id: number;
  name: string;
}

const ROWS: Row[] = [
  { id: 10, name: "Alpha" },
  { id: 20, name: "Bravo" },
  { id: 30, name: "Charlie" },
];

const byId = (row: Row) => row.id;

describe("visibleSelection", () => {
  it("returns nothing when nothing is selected", () => {
    expect([...visibleSelection(new Set(), ROWS, byId)]).toEqual([]);
  });

  it("returns nothing when no row carries a selected id", () => {
    expect([...visibleSelection(new Set([99]), ROWS, byId)]).toEqual([]);
  });

  it("keeps the ids whose row is still on screen", () => {
    expect([...visibleSelection(new Set([10, 30]), ROWS, byId)]).toEqual([10, 30]);
  });

  // The whole point: an id left over from a row that has since dropped out of
  // the result set must not survive into the usable selection.
  it("drops ids whose row has left the result set", () => {
    const afterPoll = ROWS.filter((row) => row.id !== 20);
    expect([...visibleSelection(new Set([10, 20, 30]), afterPoll, byId)]).toEqual([10, 30]);
  });

  it("returns nothing when every row has left the result set", () => {
    expect([...visibleSelection(new Set([10, 20]), [], byId)]).toEqual([]);
  });

  // Bulk payloads are built from this, so the order must come from the rows on
  // screen rather than from whichever checkbox the admin happened to click first.
  it("follows row order, not selection order", () => {
    expect([...visibleSelection(new Set([30, 10, 20]), ROWS, byId)]).toEqual([10, 20, 30]);
  });

  it("does not mutate the selection it was given", () => {
    const selected = new Set([10, 99]);
    visibleSelection(selected, ROWS, byId);
    expect([...selected]).toEqual([10, 99]);
  });
});
