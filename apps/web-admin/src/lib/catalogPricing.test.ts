/**
 * Pricing review I2: the catalog's pricing summary must say what the server
 * actually does to a SKU. The resync and Apply now reprice every auto-priced
 * Digiflazz-routed SKU (source "digiflazz" or the legacy null source, with a
 * supplier SKU) whatever its category group, so such a SKU outside Game Top Up
 * is reported as automatic with a pending reprice, never as "Manual".
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "@app/core/money";
import { UNREADABLE_CATEGORY_RULE, type PricingPolicy } from "@app/db";
import { catalogPricing, isServerAutoPriced } from "./catalogPricing";

const policy: PricingPolicy = {
  globalRule: { type: "percent", value: new Decimal(15) },
  globalRuleReadable: true,
  globalRaw: { type: "percent", value: "15" },
  rounding: "none",
  roundingReadable: true,
  roundingRaw: null,
  lowMarginWarnPct: null,
};

const sku = (over: Partial<Parameters<typeof catalogPricing>[0]> = {}) => ({
  price: new Decimal(100000),
  costPrice: new Decimal(100000) as Decimal | null,
  priceOverridden: false,
  autoDeliverySource: "digiflazz" as string | null,
  supplierSku: "ml10" as string | null,
  ...over,
});

describe("catalogPricing reports what the sync and Apply now will do", () => {
  it("a Game Top Up Digiflazz SKU: automatic, selectable, pending reprice", () => {
    const p = catalogPricing(sku(), "GAME_TOPUP", policy, null);
    expect(p).toMatchObject({ automaticAvailable: true, automaticPricing: true, source: "global_default", pendingReprice: true });
    expect(p.calculatedPrice!.toString()).toBe("115000");
  });

  it.each([["PREMIUM_APPS"], [null]])("a Digiflazz SKU in a %s category is still repriced by the server, so it is not shown as Manual", (group) => {
    const p = catalogPricing(sku(), group, policy, null);
    expect(p.automaticAvailable).toBe(false); // no Auto/Manual selector outside Game Top Up
    expect(p.automaticPricing).toBe(true);
    expect(p.source).toBe("global_default");
    expect(p.calculatedPrice!.toString()).toBe("115000");
    expect(p.pendingReprice).toBe(true);
  });

  it("a legacy null-source SKU with a supplier SKU is repriced too", () => {
    const p = catalogPricing(sku({ autoDeliverySource: null }), "GAME_TOPUP", policy, null);
    expect(p).toMatchObject({ automaticPricing: true, pendingReprice: true });
  });

  it("a manual override, another provider, or no supplier SKU is manual", () => {
    expect(catalogPricing(sku({ priceOverridden: true }), "PREMIUM_APPS", policy, null)).toMatchObject({ source: "manual_sku", pendingReprice: false });
    expect(catalogPricing(sku({ autoDeliverySource: "kokinpay" }), "GAME_TOPUP", policy, null)).toMatchObject({ automaticPricing: false, source: "manual_sku" });
    expect(catalogPricing(sku({ supplierSku: null, autoDeliverySource: null }), "PREMIUM_APPS", policy, null)).toMatchObject({ automaticPricing: false, source: "manual_sku" });
  });

  it("an unreadable category rule is reported as an unreadable policy, with no computed price", () => {
    const p = catalogPricing(sku(), "GAME_TOPUP", policy, UNREADABLE_CATEGORY_RULE);
    expect(p.calculatedPrice).toBeNull();
    expect(p.warnings).toContain("unreadable_policy");
    expect(p.pendingReprice).toBe(false);
  });

  it("isServerAutoPriced mirrors the server's reprice scope", () => {
    expect(isServerAutoPriced({ autoDeliverySource: "digiflazz", supplierSku: "x" })).toBe(true);
    expect(isServerAutoPriced({ autoDeliverySource: null, supplierSku: "x" })).toBe(true);
    expect(isServerAutoPriced({ autoDeliverySource: "kokinpay", supplierSku: "x" })).toBe(false);
    expect(isServerAutoPriced({ autoDeliverySource: "digiflazz", supplierSku: null })).toBe(false);
  });
});
