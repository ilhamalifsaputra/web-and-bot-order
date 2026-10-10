/**
 * The one definition of "does this SKU draw from local stock, and can it be
 * bought right now". Covers the full deliveryType × autoDeliverySource ×
 * stock × active matrix so every consumer can rely on the same answer.
 */
import { describe, expect, it } from "vitest";
import {
  fulfillmentSourceOf,
  hasSellableStock,
  resolveDenominationAvailability,
  usesLocalInventory,
  type FulfillmentSource,
} from "./productAvailability";

const DELIVERY_TYPES = ["auto", "manual", "manual_with_info"] as const;
const SOURCES = [null, "digiflazz"] as const;
const STOCKS = [0, 5, null] as const;

function expectedSource(deliveryType: string, autoDeliverySource: string | null): FulfillmentSource {
  if (autoDeliverySource === "digiflazz") return "PROVIDER_API";
  if (deliveryType === "auto") return "INTERNAL_INVENTORY";
  return "MANUAL";
}

describe("fulfillmentSourceOf", () => {
  it("treats a digiflazz source as PROVIDER_API whatever the delivery type", () => {
    for (const deliveryType of DELIVERY_TYPES) {
      expect(fulfillmentSourceOf({ deliveryType, autoDeliverySource: "digiflazz" })).toBe("PROVIDER_API");
    }
  });

  it("treats auto without a provider as INTERNAL_INVENTORY", () => {
    expect(fulfillmentSourceOf({ deliveryType: "auto", autoDeliverySource: null })).toBe("INTERNAL_INVENTORY");
  });

  it("treats manual and manual_with_info without a provider as MANUAL", () => {
    expect(fulfillmentSourceOf({ deliveryType: "manual", autoDeliverySource: null })).toBe("MANUAL");
    expect(fulfillmentSourceOf({ deliveryType: "manual_with_info", autoDeliverySource: null })).toBe("MANUAL");
  });
});

describe("usesLocalInventory", () => {
  it("is true only for auto without a digiflazz source", () => {
    for (const deliveryType of DELIVERY_TYPES) {
      for (const autoDeliverySource of SOURCES) {
        expect(usesLocalInventory({ deliveryType, autoDeliverySource })).toBe(
          deliveryType === "auto" && autoDeliverySource !== "digiflazz",
        );
      }
    }
  });

  it("matches the legacy orders.ts bypass exactly (isManual === !usesLocalInventory)", () => {
    for (const deliveryType of DELIVERY_TYPES) {
      for (const autoDeliverySource of SOURCES) {
        const legacyIsManual = deliveryType !== "auto" || autoDeliverySource === "digiflazz";
        expect(!usesLocalInventory({ deliveryType, autoDeliverySource })).toBe(legacyIsManual);
      }
    }
  });
});

describe("resolveDenominationAvailability", () => {
  const base = { productActive: true, categoryActive: true };

  it("auto + digiflazz with stock 0 is AVAILABLE", () => {
    expect(
      resolveDenominationAvailability({
        ...base,
        denom: { deliveryType: "auto", autoDeliverySource: "digiflazz", isActive: true },
        availableStock: 0,
      }),
    ).toEqual({ state: "AVAILABLE", reason: null, source: "PROVIDER_API" });
  });

  it("auto + no provider with stock 0 is UNAVAILABLE out_of_inventory", () => {
    expect(
      resolveDenominationAvailability({
        ...base,
        denom: { deliveryType: "auto", autoDeliverySource: null, isActive: true },
        availableStock: 0,
      }),
    ).toEqual({ state: "UNAVAILABLE", reason: "out_of_inventory", source: "INTERNAL_INVENTORY" });
  });

  it("auto + no provider with stock 5 is AVAILABLE", () => {
    expect(
      resolveDenominationAvailability({
        ...base,
        denom: { deliveryType: "auto", autoDeliverySource: null, isActive: true },
        availableStock: 5,
      }),
    ).toEqual({ state: "AVAILABLE", reason: null, source: "INTERNAL_INVENTORY" });
  });

  it("unknown stock on internal inventory is UNKNOWN, not UNAVAILABLE", () => {
    expect(
      resolveDenominationAvailability({
        ...base,
        denom: { deliveryType: "auto", autoDeliverySource: null, isActive: true },
        availableStock: null,
      }),
    ).toEqual({ state: "UNKNOWN", reason: "inventory_unknown", source: "INTERNAL_INVENTORY" });
  });

  it("an inactive provider SKU is UNAVAILABLE admin_inactive", () => {
    expect(
      resolveDenominationAvailability({
        ...base,
        denom: { deliveryType: "auto", autoDeliverySource: "digiflazz", isActive: false },
        availableStock: 5,
      }),
    ).toEqual({ state: "UNAVAILABLE", reason: "admin_inactive", source: "PROVIDER_API" });
  });

  it("provider and manual SKUs ignore availableStock", () => {
    for (const deliveryType of DELIVERY_TYPES) {
      for (const autoDeliverySource of SOURCES) {
        if (deliveryType === "auto" && autoDeliverySource === null) continue;
        for (const availableStock of STOCKS) {
          expect(
            resolveDenominationAvailability({
              ...base,
              denom: { deliveryType, autoDeliverySource, isActive: true },
              availableStock,
            }),
          ).toEqual({ state: "AVAILABLE", reason: null, source: expectedSource(deliveryType, autoDeliverySource) });
        }
      }
    }
  });

  const inactiveCases = [
    { name: "denomination inactive", denomActive: false, productActive: true, productArchived: false, categoryActive: true },
    { name: "product inactive", denomActive: true, productActive: false, productArchived: false, categoryActive: true },
    { name: "product archived", denomActive: true, productActive: true, productArchived: true, categoryActive: true },
    { name: "category inactive", denomActive: true, productActive: true, productArchived: false, categoryActive: false },
  ];

  for (const c of inactiveCases) {
    it(`${c.name} makes every combination UNAVAILABLE admin_inactive`, () => {
      for (const deliveryType of DELIVERY_TYPES) {
        for (const autoDeliverySource of SOURCES) {
          for (const availableStock of STOCKS) {
            expect(
              resolveDenominationAvailability({
                denom: { deliveryType, autoDeliverySource, isActive: c.denomActive },
                productActive: c.productActive,
                productArchived: c.productArchived,
                categoryActive: c.categoryActive,
                availableStock,
              }),
            ).toEqual({
              state: "UNAVAILABLE",
              reason: "admin_inactive",
              source: expectedSource(deliveryType, autoDeliverySource),
            });
          }
        }
      }
    });
  }

  it("full active matrix resolves as specified", () => {
    for (const deliveryType of DELIVERY_TYPES) {
      for (const autoDeliverySource of SOURCES) {
        for (const availableStock of STOCKS) {
          const source = expectedSource(deliveryType, autoDeliverySource);
          let expected: { state: string; reason: string | null };
          if (source !== "INTERNAL_INVENTORY") expected = { state: "AVAILABLE", reason: null };
          else if (availableStock === null) expected = { state: "UNKNOWN", reason: "inventory_unknown" };
          else if (availableStock > 0) expected = { state: "AVAILABLE", reason: null };
          else expected = { state: "UNAVAILABLE", reason: "out_of_inventory" };
          expect(
            resolveDenominationAvailability({
              ...base,
              denom: { deliveryType, autoDeliverySource, isActive: true },
              availableStock,
            }),
          ).toEqual({ ...expected, source });
        }
      }
    }
  });

  it("omitted productArchived counts as not archived", () => {
    expect(
      resolveDenominationAvailability({
        denom: { deliveryType: "manual", autoDeliverySource: null, isActive: true },
        productActive: true,
        categoryActive: true,
        availableStock: null,
      }).state,
    ).toBe("AVAILABLE");
  });
});

describe("hasSellableStock", () => {
  it("is false only for a local-inventory SKU with no stock rows", () => {
    for (const deliveryType of DELIVERY_TYPES) {
      for (const autoDeliverySource of SOURCES) {
        for (const stock of [0, 3]) {
          const local = expectedSource(deliveryType, autoDeliverySource) === "INTERNAL_INVENTORY";
          expect(hasSellableStock({ deliveryType, autoDeliverySource }, stock)).toBe(!local || stock > 0);
        }
      }
    }
  });

  it("treats an auto + digiflazz SKU with zero stock as sellable", () => {
    expect(hasSellableStock({ deliveryType: "auto", autoDeliverySource: "digiflazz" }, 0)).toBe(true);
    expect(hasSellableStock({ deliveryType: "auto", autoDeliverySource: null }, 0)).toBe(false);
  });
});
