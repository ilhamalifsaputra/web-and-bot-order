import { describe, it, expect } from "vitest";
import { GAME_CATALOG, matchGameKey, findCatalogEntryByCode } from "./gameCatalog";

describe("GAME_CATALOG", () => {
  it("has exactly 41 entries", () => {
    expect(Object.keys(GAME_CATALOG).length).toBe(41);
  });
});

describe("matchGameKey", () => {
  it("matches an exact digiflazzBrand name", () => {
    expect(matchGameKey({ digiflazzBrand: "Mobile Legends", name: "irrelevant" })).toBe("mobileLegends");
  });

  it("matches case-insensitively", () => {
    expect(matchGameKey({ digiflazzBrand: "GENSHIN IMPACT", name: "irrelevant" })).toBe("genshinImpact");
  });

  it("matches with extra/collapsed whitespace", () => {
    expect(matchGameKey({ digiflazzBrand: "Free   Fire", name: "irrelevant" })).toBe("freeFire");
  });

  it("matches a hyphenated code-style string against the display name", () => {
    expect(matchGameKey({ digiflazzBrand: "valorant", name: "irrelevant" })).toBe("valorant");
  });

  it("matches a brand string with a region suffix in parentheses", () => {
    expect(matchGameKey({ digiflazzBrand: "Mobile Legends (Indonesia)", name: "irrelevant" })).toBe("mobileLegends");
  });

  it("falls back to product.name when digiflazzBrand is null and the product is Digiflazz-sourced", () => {
    expect(matchGameKey({ digiflazzBrand: null, name: "PUBG Mobile", autoDeliverySource: "digiflazz" })).toBe(
      "pubgMobile",
    );
  });

  it("does NOT fall back to product.name for a non-Digiflazz-sourced product, even when the name matches a game — a hand-created product's admin-typed name (e.g. 'Joki Mobile Legends') must never be misdetected as that game", () => {
    expect(matchGameKey({ digiflazzBrand: null, name: "Joki Mobile Legends", autoDeliverySource: null })).toBeNull();
    expect(matchGameKey({ digiflazzBrand: null, name: "PUBG Mobile" })).toBeNull(); // autoDeliverySource omitted
  });

  it("treats an empty/whitespace-only digiflazzBrand as absent, falling through to the name check", () => {
    expect(matchGameKey({ digiflazzBrand: "   ", name: "Valorant", autoDeliverySource: "digiflazz" })).toBe(
      "valorant",
    );
    expect(matchGameKey({ digiflazzBrand: "", name: "irrelevant" })).toBeNull();
  });

  it("returns null for a brand string that matches none of the 41 games", () => {
    expect(matchGameKey({ digiflazzBrand: "Netflix Premium", name: "irrelevant" })).toBeNull();
  });

  it("returns null when digiflazzBrand is null and name matches nothing", () => {
    expect(matchGameKey({ digiflazzBrand: null, name: "Spotify Premium", autoDeliverySource: "digiflazz" })).toBeNull();
  });

  it("picks the more specific catalog entry when a shorter name is a substring of a longer one", () => {
    // "Free Fire" is itself a substring of "Free Fire Max" once normalized,
    // so a naive first-match scan would misclassify "Free Fire Max" as
    // "Free Fire". The longest matching catalog name should win.
    expect(matchGameKey({ digiflazzBrand: "Free Fire Max (Indonesia)", name: "irrelevant" })).toBe("freeFireMax");
    expect(matchGameKey({ digiflazzBrand: "Free Fire", name: "irrelevant" })).toBe("freeFire");
  });
});

describe("findCatalogEntryByCode", () => {
  it("returns the matching entry for a known code", () => {
    expect(findCatalogEntryByCode("mobile-legends")).toEqual({
      code: "mobile-legends",
      name: "Mobile Legends",
      requiresZone: false,
      requiresServer: true,
    });
  });

  it("returns null for an unknown code", () => {
    expect(findCatalogEntryByCode("not-a-real-code")).toBeNull();
  });
});
