import { describe, it, expect } from "vitest";
import { gameRegionLabel, knownGameRegionLabels, knownGameRegionTokens } from "./regionLabel";
import { NARROW_LABEL_WIDTH, visualWidth } from "./buttonLimits";

describe("gameRegionLabel", () => {
  it.each([
    ["Indonesia", "\u{1F1EE}\u{1F1E9} Indonesia"],
    ["id", "\u{1F1EE}\u{1F1E9} Indonesia"],
    ["Malaysia", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["my", "\u{1F1F2}\u{1F1FE} Malaysia"],
    ["Singapore", "\u{1F1F8}\u{1F1EC} Singapore"],
    ["sg", "\u{1F1F8}\u{1F1EC} Singapore"],
    ["Filipina", "\u{1F1F5}\u{1F1ED} Filipina"],
    ["Russia", "\u{1F1F7}\u{1F1FA} Russia"],
    ["Brazil", "\u{1F1E7}\u{1F1F7} Brazil"],
    ["Global", "\u{1F310} Global"],
  ])("maps %s", (raw, label) => {
    expect(gameRegionLabel(raw)).toBe(label);
  });

  it("ignores case and surrounding or repeated spaces", () => {
    expect(gameRegionLabel("  GLOBAL ")).toBe("\u{1F310} Global");
    expect(gameRegionLabel("mAlAySiA")).toBe("\u{1F1F2}\u{1F1FE} Malaysia");
  });

  it.each(["Garena", "Activision", "Reguler", "Thailand", "", "   "])("returns null for %j", (raw) => {
    expect(gameRegionLabel(raw)).toBeNull();
  });

  it("returns null for null and undefined", () => {
    expect(gameRegionLabel(null)).toBeNull();
    expect(gameRegionLabel(undefined)).toBeNull();
  });

  it("lists every token and keeps each label within one narrow button", () => {
    expect(knownGameRegionTokens()).toEqual(expect.arrayContaining(["indonesia", "id", "global"]));
    for (const label of knownGameRegionLabels()) {
      expect(visualWidth(label), label).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
    }
  });
});
