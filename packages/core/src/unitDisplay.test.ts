import { describe, expect, it } from "vitest";
import { displayUnit, sharedIconUnits, unitIcon } from "./unitDisplay";

describe("unitDisplay registry", () => {
  it.each([
    ["Diamonds", "💎"], ["Diamond", "💎"], ["diamonds", "💎"],
    ["Coins", "🪙"], ["Delta Coins", "🪙"],
    ["World Lock", "WL"], ["World Locks", "WL"], ["world locks", "WL"],
  ])("maps %s to %s", (unit, short) => {
    expect(displayUnit(unit)).toBe(short);
  });
  it("returns an unmapped unit unchanged and never guesses", () => {
    expect(displayUnit("Bonds")).toBe("Bonds");
    expect(displayUnit("UC")).toBe("UC");
    expect(displayUnit("Weekly Diamond Pass")).toBe("Weekly Diamond Pass");
    expect(displayUnit("Diamond Pass")).toBe("Diamond Pass");
    expect(unitIcon("Weekly Diamond Pass")).toBeNull();
  });
  it("supports a per-category override without affecting the default", () => {
    const overrides = { growtopia: { Diamonds: "DL" } };
    expect(displayUnit("Diamonds", { category: "growtopia", overrides })).toBe("DL");
    expect(displayUnit("Diamonds", { category: "other", overrides })).toBe("💎");
    expect(displayUnit("Diamonds", {})).toBe("💎");
  });
  it("detects different canonical units that share an icon", () => {
    expect(sharedIconUnits(["Coins", "Delta Coins", "Diamonds"])).toEqual([{ short: "🪙", units: ["Coins", "Delta Coins"] }]);
    expect(sharedIconUnits(["Delta Coins", "Delta Coins", "Diamonds"])).toEqual([]);
    expect(sharedIconUnits(["World Lock", "World Locks"])).toEqual([]);
    expect(sharedIconUnits(["Bonds", "UC"])).toEqual([]);
  });
});
