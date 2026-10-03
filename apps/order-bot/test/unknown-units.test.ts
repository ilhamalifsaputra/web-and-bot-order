import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalProduct, type CanonicalProduct } from "@app/core/canonicalProduct";
import { logger } from "@app/core/logger";
import { isKnownUnit } from "@app/core/unitDisplay";
import { noteUnknownUnits, resetUnknownUnitsForTests } from "../src/util/unknownUnits";

const sku = (id: number, raw: string, qty?: [number, string]): CanonicalProduct => canonicalProduct({
  denomination: { id, name: raw, durationLabel: raw, supplierRawName: raw, supplierSku: `sku-${id}`, autoDeliverySource: null, isActive: true, ...(qty ? { qtyValue: qty[0], qtyUnit: qty[1] } : {}) },
  product: { id: 3, name: "Some Game", isActive: true, gameRegion: null, gameVariant: null },
  category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
}, { effectivePriceIDR: "21000", preferredCurrency: "IDR", rate: "16000", locale: "id" });

describe("isKnownUnit", () => {
  it("recognises dictionary units and aliases case-insensitively, and nothing else", () => {
    expect(isKnownUnit("Diamonds")).toBe(true);
    expect(isKnownUnit("genesis crystals")).toBe(true);
    expect(isKnownUnit("World Locks")).toBe(true);
    expect(isKnownUnit("Zorblax Shards")).toBe(false);
    expect(isKnownUnit("")).toBe(false);
  });
});

describe("noteUnknownUnits", () => {
  beforeEach(() => {
    resetUnknownUnitsForTests();
    vi.restoreAllMocks();
  });

  it("warns once per unknown unit, never for dictionary units, and never twice for the same unit", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const products = [sku(1, "100 Diamonds", [100, "Diamonds"]), sku(2, "50 Zorblax Shards", [50, "Zorblax Shards"]), sku(3, "70 Zorblax Shards", [70, "Zorblax Shards"]), sku(4, "5 Flarbs", [5, "Flarbs"])];
    expect(noteUnknownUnits(products).sort()).toEqual(["Flarbs", "Zorblax Shards"]);
    expect(warn).toHaveBeenCalledTimes(2);
    const text = warn.mock.calls.map((call) => String(call.at(-1))).join("\n");
    expect(text).toContain("Zorblax Shards");
    expect(text).toContain("unitDictionary.ts");
    // A later render of the same catalog reports nothing new.
    expect(noteUnknownUnits(products)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("ignores a product without a structured amount", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(noteUnknownUnits([sku(1, "Weekly Premium Pass")])).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
