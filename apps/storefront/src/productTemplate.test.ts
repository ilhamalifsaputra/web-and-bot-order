import { describe, expect, it } from "vitest";
import { productTemplate } from "./productTemplate";

describe("productTemplate", () => {
  it("uses the game page for a GAME_TOPUP category even in catalog flow", () => {
    expect(productTemplate({ group: "GAME_TOPUP", checkoutFlow: "catalog" })).toBe("game");
  });
  it("uses the game page for a GAME_TOPUP category in instant flow", () => {
    expect(productTemplate({ group: "GAME_TOPUP", checkoutFlow: "instant" })).toBe("game");
  });
  it("keeps the catalog page for Premium Apps and ungrouped categories", () => {
    expect(productTemplate({ group: "PREMIUM_APPS", checkoutFlow: "catalog" })).toBe("catalog");
    expect(productTemplate({ group: null, checkoutFlow: "catalog" })).toBe("catalog");
  });
  it("keeps the instant pilot working for a non-game category that opted in", () => {
    expect(productTemplate({ group: "PREMIUM_APPS", checkoutFlow: "instant" })).toBe("game");
    expect(productTemplate({ group: null, checkoutFlow: "instant" })).toBe("game");
  });
});
