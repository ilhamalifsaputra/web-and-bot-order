import { describe, expect, it } from "vitest";
import { parseDenominationCsv } from "../src/lib/catalogImport";

const cats = new Map([["games", 1]]);
const row = (...cols: string[]) => parseDenominationCsv(`Games | Some Product | 86 Diamonds | shared | 1 Month | ${cols.join(" | ")}`, cats)[0]!;

describe("parseDenominationCsv prices", () => {
  // Rupiah has no sub-unit, so "79.000" is seventy-nine thousand and must never be read as 79.
  it.each([
    ["79.000", "79000"],
    ["79,000", "79000"],
    ["1.000.000", "1000000"],
    ["79000", "79000"],
    ["4480.50", "4480.50"],
    ["4480,50", "4480.5"],
  ])("reads a price of %s as %s", (typed, canonical) => {
    const r = row(typed);
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(Number(r.data!.price)).toBe(Number(canonical));
    expect(r.data!.price).toMatch(/^\d+(\.\d+)?$/);
  });

  it("stores the canonical string, never the typed text", () => {
    const r = row("79.000", "40.000", "70,000");
    expect(r.data!.price).toBe("79000");
    expect(r.data!.costPrice).toBe("40000");
    expect(r.data!.resellerPrice).toBe("70000");
  });

  it.each(["abc", "0", "-5", "79.000.0", "1e3", "Rp79.000", "79 000", "1.2.3", ".5", "5."])("rejects a price of %j", (typed) => {
    const r = row(typed);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/price/i);
  });

  it("rejects an ambiguous or malformed cost or reseller price with its own message", () => {
    expect(row("79.000", "1e3").error).toMatch(/cost price/i);
    expect(row("79.000", "40.000", "1.2.3").error).toMatch(/reseller price/i);
  });

  it.each(["0.5", "0,5"])("rejects a sub-rupiah price of %j", (typed) => {
    const r = row(typed);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/price must be at least/i);
  });

  it("rejects a zero reseller price and one above the retail price, per row", () => {
    expect(row("79.000", "", "0").error).toMatch(/reseller price must be at least/i);
    expect(row("79.000", "", "80.000").error).toMatch(/reseller price must not be higher/i);
  });

  it("accepts a zero cost price and a reseller price equal to the price", () => {
    const r = row("79.000", "0", "79.000");
    expect(r.ok).toBe(true);
    expect(r.data!.costPrice).toBe("0");
  });

  it("a bad row does not stop the other rows from parsing", () => {
    const rows = parseDenominationCsv(
      [
        "Games | P | A | shared | 1 Month | 79.000 | | 80.000",
        "Games | P | B | shared | 1 Month | 79.000 | 40.000 | 70.000",
      ].join("\n"),
      cats,
    );
    expect(rows.map((r) => r.ok)).toEqual([false, true]);
    expect(rows[1]!.data!.resellerPrice).toBe("70000");
  });

  it("leaves a blank cost and reseller price empty", () => {
    const r = row("79.000", "", "");
    expect(r.ok).toBe(true);
    expect(r.data!.costPrice).toBeNull();
    expect(r.data!.resellerPrice).toBeNull();
  });
});
