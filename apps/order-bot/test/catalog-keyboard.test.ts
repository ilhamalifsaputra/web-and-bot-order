import { describe, expect, it } from "vitest";
import { canonicalDenominationPickerKb, denominationDetailKb } from "../src/keyboards/customer";
import type { CatalogButton } from "../src/util/canonicalPresenter";

// Synthetic fixtures: ids/labels are made up, only the keyboard shape matters.
const btn = (id: number): CatalogButton => ({ text: `P${id}`, callback_data: `v1:browse:denom:${id}` });
const rowsOf = (kb: ReturnType<typeof canonicalDenominationPickerKb>) =>
  kb.inline_keyboard.map((r) => r.map((b) => ("callback_data" in b ? b.callback_data : "")));

describe("canonicalDenominationPickerKb rows", () => {
  it("odd product count: last product stays alone on its row, Refresh and Back have own rows", () => {
    const kb = canonicalDenominationPickerKb([[btn(1), btn(2)], [btn(3)]], 7, "en", 0, 1);
    expect(rowsOf(kb)).toEqual([
      ["v1:browse:denom:1", "v1:browse:denom:2"],
      ["v1:browse:denom:3"],
      ["v1:browse:pick:7:0"],
      ["v1:browse:prods"],
    ]);
  });

  it("even product count: no nav button joins the last product row", () => {
    const kb = canonicalDenominationPickerKb([[btn(1), btn(2)], [btn(3), btn(4)]], 7, "en", 0, 1);
    const rows = rowsOf(kb);
    expect(rows[1]).toEqual(["v1:browse:denom:3", "v1:browse:denom:4"]);
    expect(rows.slice(2)).toEqual([["v1:browse:pick:7:0"], ["v1:browse:prods"]]);
  });

  it("multi-page middle page: Prev/Next share one row between products and Refresh", () => {
    const kb = canonicalDenominationPickerKb([[btn(1), btn(2)], [btn(3)]], 7, "en", 1, 3);
    expect(rowsOf(kb)).toEqual([
      ["v1:browse:denom:1", "v1:browse:denom:2"],
      ["v1:browse:denom:3"],
      ["v1:browse:pick:7:0", "v1:browse:pick:7:2"],
      ["v1:browse:pick:7:1"],
      ["v1:browse:prods"],
    ]);
  });

  it("first page has only Next, last page has only Prev", () => {
    expect(rowsOf(canonicalDenominationPickerKb([[btn(1)]], 7, "en", 0, 2))[1]).toEqual(["v1:browse:pick:7:1"]);
    expect(rowsOf(canonicalDenominationPickerKb([[btn(1)]], 7, "en", 1, 2))[1]).toEqual(["v1:browse:pick:7:0"]);
  });

  it("single page: no pagination row at all", () => {
    const rows = rowsOf(canonicalDenominationPickerKb([[btn(1)]], 7, "en", 0, 1));
    expect(rows).toHaveLength(3);
  });

  it("empty rows (intro-only page) still keeps arrows, Refresh and Back", () => {
    const kb = canonicalDenominationPickerKb([], 7, "en", 1, 3);
    expect(rowsOf(kb)).toEqual([
      ["v1:browse:pick:7:0", "v1:browse:pick:7:2"],
      ["v1:browse:pick:7:1"],
      ["v1:browse:prods"],
    ]);
    expect(rowsOf(canonicalDenominationPickerKb([], 7, "en", 0, 1))).toEqual([["v1:browse:pick:7:0"], ["v1:browse:prods"]]);
  });

  it("does not mutate the passed rows", () => {
    const input = [[btn(1), btn(2)], [btn(3)]];
    const snapshot = JSON.stringify(input);
    canonicalDenominationPickerKb(input, 7, "en", 0, 2);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toHaveLength(2);
  });

  it("every callback_data stays within Telegram's 64-byte limit", () => {
    const kb = canonicalDenominationPickerKb([[btn(123456789)]], 987654321, "en", 40, 99);
    for (const b of kb.inline_keyboard.flat()) {
      expect(Buffer.byteLength("callback_data" in b ? b.callback_data : "", "utf8")).toBeLessThanOrEqual(64);
    }
  });
});

describe("denominationDetailKb Back target", () => {
  const denom = { id: 5, deliveryType: "MANUAL", name: "x", price: "1000" } as unknown as Parameters<typeof denominationDetailKb>[0];
  const backData = (kb: ReturnType<typeof denominationDetailKb>) => {
    const last = kb.inline_keyboard[kb.inline_keyboard.length - 1]!;
    return last.map((b) => ("callback_data" in b ? b.callback_data : ""));
  };

  it("returns to the picker page it came from", () => {
    expect(backData(denominationDetailKb(denom, 1, "en", 1, 7, 2))).toEqual(["v1:browse:pick:7:2"]);
  });

  it("page 0 / unknown page keeps the plain picker callback", () => {
    expect(backData(denominationDetailKb(denom, 1, "en", 1, 7))).toEqual(["v1:browse:pick:7"]);
    expect(backData(denominationDetailKb(denom, 1, "en", 1, 7, 0))).toEqual(["v1:browse:pick:7"]);
  });

  it("falls back to the product list when there is no parent product", () => {
    expect(backData(denominationDetailKb(denom, 1, "en", 1, null, 3))).toEqual(["v1:browse:prods"]);
  });
});
