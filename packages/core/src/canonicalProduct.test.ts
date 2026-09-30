import { describe, expect, it } from "vitest";
import catalog from "./detection/__fixtures__/catalogSnapshot.json";
import { canonicalProduct, CanonicalProductSchema, type CanonicalProductInput } from "./canonicalProduct";

const input = (name: string, overrides: Partial<CanonicalProductInput["denomination"]> = {}, productName = "Mobile Legends"): CanonicalProductInput => ({
  denomination: { id: 17, name, durationLabel: name, supplierRawName: name, supplierSku: "fixture-17", autoDeliverySource: "digiflazz", isActive: true, ...overrides },
  product: { id: 3, name: productName, isActive: true },
  category: { id: 1, name: "Top Up", group: "GAME_TOPUP", isActive: true },
});
const context = { effectivePriceIDR: "130833.1254", preferredCurrency: "IDR" as const, locale: "id", generatedAt: "2026-09-30T00:00:00.000Z" };
const present = (name: string, overrides = {}, productName?: string) => canonicalProduct(input(name, overrides, productName), context);

describe("canonical product semantics", () => {
  it("reports the actual rate source and confirmation time, never render time", () => {
    const result = canonicalProduct(input("86 Diamonds"), { ...context, preferredCurrency: "USD", rate: "16000", rateSource: "settings:usd_idr_rate", rateAsOf: "2026-09-29T04:00:00.000Z" });
    expect(result.conversion).toMatchObject({ source: "settings:usd_idr_rate", asOf: "2026-09-29T04:00:00.000Z" });
    const fallback = canonicalProduct(input("86 Diamonds"), { ...context, preferredCurrency: "USD", rate: "16000", rateSource: "config:USDT_IDR_RATE" });
    expect(fallback.conversion).toMatchObject({ source: "config:USDT_IDR_RATE", asOf: null });
  });
  it("interprets verified Digiflazz dot grouping without losing supplier identity", () => {
    const real = catalog.find((row) => row.denominationName === "Mobile Legends 1.050 Diamonds")!;
    const result = present(real.denominationName);
    expect(result.variant).toMatchObject({ type: "amount", quantity: 1050, unit: "Diamonds", residual: [] });
    expect(result.displayName).toBe("1050 Diamonds");
    expect(result).toMatchObject({ id: 17, supplierSku: "fixture-17", rawName: real.denominationName, rawNameProvenance: "supplier" });
  });
  it("preserves Infinite before quantity as a variant qualifier", () => {
    const real = catalog.find((row) => row.denominationName === "Arena Breakout Infinite 10.000 Bonds")!;
    const result = present(real.denominationName, {}, "Arena Breakout");
    expect(result.variant).toMatchObject({ type: "amount", quantity: 10000, unit: "Bonds", residual: ["Infinite"] });
    expect(result.displayName).toContain("Infinite");
  });
  it.each([
    ["PUBG MOBILE 9375 UC", "PUBG Mobile", 9375, "UC"],
    ["Valorant 1.000 VP", "Valorant", 1000, "VP"],
    ["Free Fire 5 Diamond", "Free Fire", 5, "Diamond"],
  ])("interprets real catalog %s without losing its complete unit", (name, productName, quantity, unit) => {
    const real = catalog.find((row) => row.denominationName === name)!;
    expect(present(real.denominationName, {}, productName).variant).toMatchObject({ type: "amount", quantity, unit });
  });
  it.each(["Chest O Gems", "Gem Fountain", "Its Rainin Gems", "Gem Bounty"])("preserves real Growtopia named package %s", (name) => {
    const real = catalog.find((row) => row.denominationName === `Growtopia ${name}`)!;
    const result = present(real.denominationName, {}, "Growtopia");
    expect(result.variant.type).toBe("package");
    expect(result.displayName).toBe(name);
  });
  it("retains an unambiguous synthetic bonus and all trailing qualifiers", () => {
    const result = present("Mobile Legends 86 Diamonds + 8 Bonus (Indonesia) Server A via ID Promo");
    expect(result.variant).toMatchObject({ type: "amount", quantity: 86, bonus: { quantity: 8, unit: "Diamonds" } });
    expect(result.displayName).toContain("+ 8 Bonus");
    expect(result.displayName).toContain("(Indonesia) Server A via ID Promo");
  });
  it("recognizes real shared-unit bonus notation without treating bonus as primary amount", () => {
    const real = catalog.find((row) => row.denominationName === "Mobile Legends 150 + 15 Diamonds")!;
    const result = present(real.denominationName);
    expect(result.variant).toMatchObject({ type: "amount", quantity: 150, unit: "Diamonds", bonus: { quantity: 15, unit: "Diamonds" } });
    expect(result.displayName).toContain("150 Diamonds + 15 Diamonds");
  });
  it("prioritizes structured quantity while retaining contradictory supplier text", () => {
    const result = present("Mobile Legends 86 Diamonds + 8 Bonus Global", { qtyValue: 100, qtyUnit: "Diamonds" });
    expect(result.variant).toMatchObject({ type: "amount", quantity: 100, unit: "Diamonds" });
    expect(result.displayName).toContain("86 Diamonds + 8 Bonus Global");
    expect(result.displayName).toContain("100 Diamonds");
  });
  it("retains different name and duration fields in addition to supplier name", () => {
    const result = present("Mobile Legends 86 Diamonds Global", { name: "Admin VIP", durationLabel: "7 Days" });
    expect(result.displayName).toContain("Admin VIP");
    expect(result.displayName).toContain("7 Days");
    expect(result.displayName).toContain("Global");
  });
  it("retains differing editable names even when they are substrings of supplier tokens", () => {
    const result = present("MysteryAB", { name: "Mystery", durationLabel: "MysteryAB" });
    expect(result.variant.residual).toContain("Mystery");
  });
  it("does not interpret ambiguous commas or unverified supplier dot grouping", () => {
    expect(present("Mobile Legends 10,000 Bonds").variant.type).toBe("unknown");
    expect(present("Mobile Legends 1.050 Diamonds", { autoDeliverySource: null }).variant.type).toBe("unknown");
  });
  it.each(["1, 050 Diamonds", "1 050 Diamonds", "1, 234 Diamonds", "1 234 Diamonds", "1 , 050 Diamonds", "1,050 + 15 Diamonds"])("does not reinterpret a suffix of unsupported grouping %s", (name) => {
    const rawName = `Mobile Legends ${name}`;
    const result = present(rawName);
    expect(result.variant.type).toBe("unknown");
    expect(result.displayName).toBe(name);
    expect(result.rawName).toBe(rawName);
  });
  it.each(["1, 050 Diamonds", "1 050 Diamonds"])("preserves ambiguous %s beside a structured quantity rather than agreeing with its tail", (name) => {
    const result = present(`Mobile Legends ${name}`, { qtyValue: 50, qtyUnit: "Diamonds" });
    expect(result.variant).toMatchObject({ type: "amount", quantity: 50, residual: [name] });
    expect(result.displayName).toContain(name);
  });
  it("still parses a simple quantity after a genuine named qualifier", () => {
    const result = present("Arena Breakout Infinite 50 Bonds", {}, "Arena Breakout");
    expect(result.variant).toMatchObject({ type: "amount", quantity: 50, unit: "Bonds", residual: ["Infinite"] });
  });
  it("keeps game names inside meaningful text and refuses unverified short aliases", () => {
    expect(present("Special Mobile Legends Bundle").displayName).toBe("Special Mobile Legends Bundle");
    expect(present("ML 86 Diamonds").displayName).toContain("ML");
    expect(present("Mobile LegendsX 86 Diamonds").displayName).toContain("Mobile LegendsX");
  });
  it("preserves World Lock as a semantic unit", () => {
    expect(present("Growtopia 100 World Lock", {}, "Growtopia").variant).toMatchObject({ type: "amount", quantity: 100, unit: "World Lock" });
  });
  it("models real subscription duration and pass names without dropping terms", () => {
    expect(present("Growtopia 1 Year Subscription Token", {}, "Growtopia").variant).toMatchObject({ type: "subscription", name: "1 Year Subscription Token", duration: { value: 1, unit: "year" } });
    expect(present("Mobile Legends Weekly Diamond Pass").displayName).toBe("Weekly Diamond Pass");
    expect(present("Mobile Legends Weekly Diamond Pass").variant.type).toBe("pass");
  });
  it("does not infer a positive duration from signed or fractional duration text", () => {
    for (const name of ["-1 Year Subscription", "1.5 Year Subscription"]) {
      expect(present(name).variant).not.toHaveProperty("duration");
      expect(present(name).displayName).toBe(name);
    }
  });
  it.each([
    ["Growtopia Gem Fountain", "Growtopia", "package"],
    ["Growtopia 1 Year Subscription Token", "Growtopia", "subscription"],
    ["Mobile Legends Weekly Diamond Pass", "Mobile Legends", "pass"],
  ])("keeps named %s semantics when structured quantity is also set", (name, productName, type) => {
    const result = present(name, { qtyValue: 7, qtyUnit: "Tokens" }, productName);
    expect(result.variant.type).toBe(type);
    expect(result.displayName).toContain("7 Tokens");
    expect(result.displayName).toContain(name.replace(`${productName} `, ""));
  });
  it("retains multiple bonus clauses instead of overwriting the first bonus", () => {
    const result = present("Mobile Legends 150 + 15 Diamonds + 5 Diamonds Promo");
    expect(result.displayName).toContain("15 Diamonds");
    expect(result.displayName).toContain("5 Diamonds Promo");
  });
  it("preserves unknown names and legacy provenance without inventing supplier history", () => {
    const result = present("Mystery Ω 限定", { supplierRawName: null, supplierSku: null });
    expect(result.variant.type).toBe("unknown");
    expect(result).toMatchObject({ rawName: "Mystery Ω 限定", rawNameProvenance: "legacy_name", createdAt: null });
    expect(result.generatedAt).toBe(context.generatedAt);
    expect(result).not.toHaveProperty("updatedAt");
  });
  it("keeps conflicting region and edition qualifiers independently", () => {
    const data = input("Mobile Legends 86 Diamonds (Global)");
    data.product.gameRegion = "Indonesia";
    data.product.gameVariant = "Fast";
    const result = canonicalProduct(data, context);
    expect(result.qualifiers).toEqual(["Indonesia", "Fast"]);
    expect(result.displayName).toContain("Global");
  });
});

describe("canonical exact price and runtime contract", () => {
  it.each([
    ["0", "0", 0, "Rp0"],
    ["130833.1254", "1308331254", 4, "Rp130.833,1254"],
    ["999999999999.9999", "9999999999999999", 4, "Rp999.999.999.999,9999"],
    ["0.0001", "1", 4, "Rp0,0001"],
  ])("encodes exact IDR %s as integer digits with its scale", (value, amountMinor, scale, formattedPrice) => {
    const result = canonicalProduct(input("Mobile Legends 86 Diamonds"), { ...context, effectivePriceIDR: value });
    expect(result.priceIDR).toEqual({ currency: "IDR", amountMinor, scale });
    expect(result.displayPrice).toEqual(result.priceIDR);
    expect(result.formattedPrice).toBe(formattedPrice);
  });
  it("formats exact fractions using English separators when requested", () => {
    expect(canonicalProduct(input("86 Diamonds"), { ...context, locale: "en" }).formattedPrice).toBe("Rp130,833.1254");
  });
  it("uses existing ceil-to-cent conversion and explicitly identifies USDT rate basis", () => {
    const result = canonicalProduct(input("86 Diamonds"), { ...context, effectivePriceIDR: "130833", preferredCurrency: "USD", rate: "16000" });
    expect(result.displayPrice).toEqual({ currency: "USD", amountMinor: "818", scale: 2 });
    expect(result.formattedPrice).toBe("$8,18");
    expect(result.conversion).toMatchObject({ basis: "USDT", direction: "IDR_PER_USDT", rate: "16000", rounding: "CEIL_2DP" });
    expect(result.conversion).toMatchObject({ source: "caller", asOf: null });
  });
  it.each([undefined, null, "0", "-1", "NaN", "garbage"])("falls back to exact IDR for unusable rate %s", (rate) => {
    const result = canonicalProduct(input("86 Diamonds"), { ...context, preferredCurrency: "USD", rate });
    expect(result.displayPrice.currency).toBe("IDR");
    expect(result.currencyFallback).toBe(true);
    expect(result.conversion).toBeNull();
  });
  it.each(["-1", "NaN", "Infinity", "1.12345"])("rejects invalid or unsupported exact selling price %s", (effectivePriceIDR) => {
    expect(() => canonicalProduct(input("86 Diamonds"), { ...context, effectivePriceIDR })).toThrow();
  });
  it("marks parent inactivity and stock accurately without refusing unknown semantics", () => {
    const data = input("Mystery");
    expect(canonicalProduct(data, context).availability.purchasable).toBe(true);
    expect(canonicalProduct({ ...data, stockAvailable: false }, context).availability).toEqual({ status: "out_of_stock", purchasable: false });
    data.category.isActive = false;
    expect(canonicalProduct(data, context).availability).toEqual({ status: "inactive", purchasable: false });
  });
  it("rejects malformed money, unsafe quantities and inconsistent purchasable status at runtime", () => {
    const result = present("86 Diamonds");
    expect(CanonicalProductSchema.safeParse(result).success).toBe(true);
    for (const displayPrice of [ { currency: "IDR", amountMinor: "1.2", scale: 0 }, { currency: "USD", amountMinor: "123", scale: 0 }, { currency: "IDR", amountMinor: "1", scale: 5 } ]) {
      expect(CanonicalProductSchema.safeParse({ ...result, displayPrice }).success).toBe(false);
    }
    expect(CanonicalProductSchema.safeParse({ ...result, variant: { type: "amount", quantity: Number.MAX_SAFE_INTEGER + 1, unit: "UC", residual: [] } }).success).toBe(false);
    expect(CanonicalProductSchema.safeParse({ ...result, availability: { status: "inactive", purchasable: true } }).success).toBe(false);
  });
});
