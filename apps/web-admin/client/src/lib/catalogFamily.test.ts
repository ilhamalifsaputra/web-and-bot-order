import { describe, it, expect } from "vitest";
import {
  FAMILY_REGISTRY,
  ALL_TAB,
  familyOfGroup,
  familyTabFromParam,
  familyTabOptions,
  familyTabToParam,
  matchesFamilyTab,
  type FamilyDef,
} from "./catalogFamily";

describe("catalogFamily", () => {
  it("resolves a category group to its family, treating a legacy null/unknown group as Premium Apps", () => {
    expect(familyOfGroup("GAME_TOPUP")).toBe("GAME_TOPUP");
    expect(familyOfGroup("PREMIUM_APPS")).toBe("PREMIUM_APPS");
    expect(familyOfGroup(null)).toBe("PREMIUM_APPS");
    expect(familyOfGroup(undefined)).toBe("PREMIUM_APPS");
    expect(familyOfGroup("SOMETHING_ELSE")).toBe("PREMIUM_APPS");
  });

  it("matches every row under All and only its own family otherwise", () => {
    expect(matchesFamilyTab("GAME_TOPUP", ALL_TAB)).toBe(true);
    expect(matchesFamilyTab(null, ALL_TAB)).toBe(true);
    expect(matchesFamilyTab("GAME_TOPUP", "GAME_TOPUP")).toBe(true);
    expect(matchesFamilyTab("GAME_TOPUP", "PREMIUM_APPS")).toBe(false);
    expect(matchesFamilyTab(null, "PREMIUM_APPS")).toBe(true);
    expect(matchesFamilyTab(null, "GAME_TOPUP")).toBe(false);
  });

  it("round-trips the ?tab= param and falls back to All for anything unknown", () => {
    expect(familyTabFromParam("game")).toBe("GAME_TOPUP");
    expect(familyTabFromParam("apps")).toBe("PREMIUM_APPS");
    expect(familyTabFromParam(null)).toBe(ALL_TAB);
    expect(familyTabFromParam("nonsense")).toBe(ALL_TAB);
    expect(familyTabToParam(ALL_TAB)).toBeNull();
    expect(familyTabFromParam(familyTabToParam("GAME_TOPUP"))).toBe("GAME_TOPUP");
    expect(familyTabFromParam(familyTabToParam("PREMIUM_APPS"))).toBe("PREMIUM_APPS");
  });

  it("lists All Products first, then one option per registry entry in order", () => {
    expect(familyTabOptions()).toEqual([
      { value: "all", label: "All Products" },
      { value: "GAME_TOPUP", label: "Game Top-Up" },
      { value: "PREMIUM_APPS", label: "Digital Apps" },
    ]);
  });

  it("derives a third tab, its param and its matching from one extra registry entry", () => {
    const registry: FamilyDef[] = [
      ...FAMILY_REGISTRY,
      { group: "GIFT_CARDS", tabLabel: "Gift Cards", param: "gift" },
    ];
    expect(familyTabOptions(registry).map((o) => o.label)).toEqual([
      "All Products",
      "Game Top-Up",
      "Digital Apps",
      "Gift Cards",
    ]);
    expect(familyTabFromParam("gift", registry)).toBe("GIFT_CARDS");
    expect(familyTabToParam("GIFT_CARDS", registry)).toBe("gift");
    expect(matchesFamilyTab("GIFT_CARDS", "GIFT_CARDS", registry)).toBe(true);
    expect(matchesFamilyTab("GIFT_CARDS", "PREMIUM_APPS", registry)).toBe(false);
    // The legacy fallback is unchanged by the new entry.
    expect(familyOfGroup(null, registry)).toBe("PREMIUM_APPS");
  });
});
