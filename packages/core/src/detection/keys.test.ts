import { describe, it, expect } from "vitest";
import { buildBaseProductKey, buildProductKey, buildSkuKey } from "./keys";
import type { TokenCategory } from "./types";

const platform = { category: "platform" as TokenCategory, canonical: "mobile" };
const edition = { category: "edition" as TokenCategory, canonical: "pro" };
const region = { category: "region" as TokenCategory, canonical: "id" };
const distribution = { category: "distribution" as TokenCategory, canonical: "garena" };

describe("buildBaseProductKey", () => {
  it("joins core tokens with a single space, preserving order", () => {
    expect(buildBaseProductKey(["legends", "of", "valor"])).toBe("legends of valor");
  });

  it("does not sort core tokens — word order is meaningful", () => {
    expect(buildBaseProductKey(["b", "a"])).toBe("b a");
  });

  it("returns an empty string for no core tokens", () => {
    expect(buildBaseProductKey([])).toBe("");
  });
});

describe("buildProductKey", () => {
  it("returns baseProductKey unchanged (no '::' suffix) when there are no defining tokens", () => {
    expect(buildProductKey("legends", [])).toBe("legends");
  });

  it("appends sorted defining pairs after '::'", () => {
    const key = buildProductKey("legends", [platform, edition]);
    expect(key).toBe("legends::edition=pro,platform=mobile");
  });

  it("is stable (INV-4) regardless of defining-token array order", () => {
    const a = buildProductKey("legends", [platform, edition]);
    const b = buildProductKey("legends", [edition, platform]);
    expect(a).toBe(b);
    expect(a).toBe("legends::edition=pro,platform=mobile");
  });

  it("deduplicates by [category, canonical]", () => {
    const key = buildProductKey("legends", [platform, platform, edition]);
    expect(key).toBe("legends::edition=pro,platform=mobile");
  });

  it("keeps distinct canonicals within the same category separate", () => {
    const platformPc = { category: "platform" as TokenCategory, canonical: "pc" };
    const key = buildProductKey("legends", [platform, platformPc]);
    expect(key).toBe("legends::platform=mobile,platform=pc");
  });

  it("never collides two different defining-token sets onto the same key (spot check)", () => {
    const keyA = buildProductKey("legends", [platform]);
    const keyB = buildProductKey("legends", [edition]);
    const keyC = buildProductKey("legends", [platform, edition]);
    const keys = new Set([keyA, keyB, keyC]);
    expect(keys.size).toBe(3);
  });
});

describe("buildSkuKey", () => {
  it("uses 'none' when denomination is null", () => {
    expect(buildSkuKey("legends", null, [])).toBe("legends::denom=none");
  });

  it("embeds a non-null denomination verbatim", () => {
    expect(buildSkuKey("legends", "100", [])).toBe("legends::denom=100");
  });

  it("appends sorted distribution pairs after the denom segment", () => {
    const key = buildSkuKey("legends", "100", [region, distribution]);
    expect(key).toBe("legends::denom=100,distribution=garena,region=id");
  });

  it("is stable (INV-4) regardless of distribution-token array order", () => {
    const a = buildSkuKey("legends", "100", [region, distribution]);
    const b = buildSkuKey("legends", "100", [distribution, region]);
    expect(a).toBe(b);
    expect(a).toBe("legends::denom=100,distribution=garena,region=id");
  });

  it("deduplicates distribution tokens by [category, canonical]", () => {
    const key = buildSkuKey("legends", "100", [region, region]);
    expect(key).toBe("legends::denom=100,region=id");
  });

  it("never collides two different (denomination, distribution) combos onto the same key (spot check)", () => {
    const keyA = buildSkuKey("legends", "100", [region]);
    const keyB = buildSkuKey("legends", "200", [region]);
    const keyC = buildSkuKey("legends", "100", [distribution]);
    const keys = new Set([keyA, keyB, keyC]);
    expect(keys.size).toBe(3);
  });
});

describe("end-to-end key construction stability (INV-4)", () => {
  it("produces byte-identical productKey/skuKey from logically-equal inputs built via buildBaseProductKey first", () => {
    const base = buildBaseProductKey(["legends"]);

    const productKeyAB = buildProductKey(base, [platform, edition]);
    const productKeyBA = buildProductKey(base, [edition, platform]);
    expect(productKeyAB).toBe(productKeyBA);

    const skuKeyAB = buildSkuKey(productKeyAB, "100", [region, distribution]);
    const skuKeyBA = buildSkuKey(productKeyBA, "100", [distribution, region]);
    expect(skuKeyAB).toBe(skuKeyBA);
  });
});
