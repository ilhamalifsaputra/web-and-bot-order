/**
 * resolveDenomIconKind() — the per-product currency-icon resolution rule
 * (Fase 12, mirrors images.test.ts's coverage shape for defaultThumbKind).
 */
import { describe, it, expect } from "vitest";
import { resolveDenomIconKind } from "./denomIcon";

describe("resolveDenomIconKind", () => {
  it("uses the admin's currencyIconKind override when set (non-PREMIUM_APPS)", () => {
    expect(
      resolveDenomIconKind({ currencyIconKind: "key" }, { group: null }, "Anything"),
    ).toBe("key");
  });

  it("forces null for PREMIUM_APPS even when an admin override is set", () => {
    expect(
      resolveDenomIconKind(
        { currencyIconKind: "diamond" },
        { group: "PREMIUM_APPS" },
        "Diamonds",
      ),
    ).toBeNull();
  });

  it("forces null for PREMIUM_APPS even with no override and a matching qtyUnit", () => {
    expect(
      resolveDenomIconKind({ currencyIconKind: null }, { group: "PREMIUM_APPS" }, "Diamonds"),
    ).toBeNull();
  });

  it("ignores an unrecognized currencyIconKind and falls through to the heuristic", () => {
    expect(
      resolveDenomIconKind(
        { currencyIconKind: "not-a-real-kind" },
        { group: null },
        "500 Diamonds",
      ),
    ).toBe("diamond");
  });

  describe("qtyUnit substring heuristic (case-insensitive)", () => {
    it('matches "diamond"', () => {
      expect(
        resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "86 Diamonds"),
      ).toBe("diamond");
    });

    it('matches "UC"', () => {
      expect(resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "60 UC")).toBe(
        "coin",
      );
    });

    it('matches "coin"', () => {
      expect(
        resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "100 Coins"),
      ).toBe("coin");
    });

    it('matches "gold"', () => {
      expect(resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "Gold Bars")).toBe(
        "coin",
      );
    });

    it('matches "CP"', () => {
      expect(resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "500 CP")).toBe(
        "coin",
      );
    });

    it('matches "point"', () => {
      expect(
        resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "1000 Points"),
      ).toBe("coin");
    });
  });

  it("falls back to diamond for GAME_TOPUP categories when qtyUnit doesn't match", () => {
    expect(
      resolveDenomIconKind({ currencyIconKind: null }, { group: "GAME_TOPUP" }, "Bundle A"),
    ).toBe("diamond");
  });

  it("falls back to diamond for GAME_TOPUP categories when qtyUnit is null", () => {
    expect(resolveDenomIconKind({ currencyIconKind: null }, { group: "GAME_TOPUP" }, null)).toBe(
      "diamond",
    );
  });

  it("returns null for an ungrouped category with no qtyUnit match", () => {
    expect(
      resolveDenomIconKind({ currencyIconKind: null }, { group: null }, "Bundle A"),
    ).toBeNull();
  });

  it("treats a null/undefined category as no match (null)", () => {
    expect(resolveDenomIconKind({ currencyIconKind: null }, null, null)).toBeNull();
    expect(resolveDenomIconKind({ currencyIconKind: null }, undefined, null)).toBeNull();
  });

  it("returns null when qtyUnit is null/undefined and category doesn't fall back", () => {
    expect(resolveDenomIconKind({ currencyIconKind: null }, { group: null }, null)).toBeNull();
    expect(
      resolveDenomIconKind({ currencyIconKind: null }, { group: null }, undefined),
    ).toBeNull();
  });
});
