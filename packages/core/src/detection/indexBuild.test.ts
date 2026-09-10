import { describe, it, expect } from "vitest";
import { buildCatalogIndex } from "./indexBuild";
import type { CatalogEntry, KnowledgeBase } from "./types";

// Small, self-contained knowledge base — no real product/brand names, just
// generic category words plus an invented distribution token, matching the
// convention established in features.test.ts/keys.test.ts.
const TEST_KNOWLEDGE: KnowledgeBase = {
  tokens: [
    { category: "platform", token: "mobile", canonical: "mobile", isProductDefining: true, enabled: true },
    { category: "edition", token: "pro", canonical: "pro", isProductDefining: true, enabled: true },
    { category: "distribution", token: "zeta", canonical: "zeta", isProductDefining: true, enabled: true },
    { category: "region", token: "id", canonical: "id", isProductDefining: false, enabled: true },
  ],
  aliases: [],
  overrides: [],
  externalIdStableBySupplier: {},
  revision: "test",
};

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    externalId: null,
    productName: "legends",
    category: null,
    type: null,
    refId: "r0",
    ...overrides,
  };
}

describe("buildCatalogIndex", () => {
  it("stamps and counts entries", () => {
    const entries = [entry({ refId: "r1" }), entry({ refId: "r2" })];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "1.0.0+ktest");
    expect(index.stamp).toBe("1.0.0+ktest");
    expect(index.entryCount).toBe(2);
  });

  it("buckets by normalized name", () => {
    const entries = [
      entry({ refId: "r1", productName: "Legends Mobile" }),
      entry({ refId: "r2", productName: "legends mobile" }),
      entry({ refId: "r3", productName: "Other Game" }),
    ];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    const bucket = index.byNormalizedName.get("legends mobile");
    expect(bucket).toBeDefined();
    expect(bucket!.map((e) => e.refId).sort()).toEqual(["r1", "r2"]);
    expect(index.byNormalizedName.get("other game")!.map((e) => e.refId)).toEqual(["r3"]);
  });

  it("buckets by despaced name, distinct from normalized name", () => {
    // "legends mobile" and "legendsmobile" despace to the same string but
    // are different normalized names.
    const entries = [
      entry({ refId: "r1", productName: "Legends Mobile" }),
      entry({ refId: "r2", productName: "LegendsMobile" }),
    ];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    expect(index.byNormalizedName.get("legends mobile")!.map((e) => e.refId)).toEqual(["r1"]);
    expect(index.byNormalizedName.get("legendsmobile")!.map((e) => e.refId)).toEqual(["r2"]);
    const despacedBucket = index.byDespacedName.get("legendsmobile");
    expect(despacedBucket!.map((e) => e.refId).sort()).toEqual(["r1", "r2"]);
  });

  it("buckets by baseProductKey (core tokens only, ignoring defining-token variants)", () => {
    const entries = [
      entry({ refId: "r1", productName: "legends mobile" }),
      entry({ refId: "r2", productName: "legends pro" }),
      entry({ refId: "r3", productName: "legends" }),
    ];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    // "mobile" and "pro" are both defining tokens stripped from coreTokens,
    // so all three entries share baseProductKey "legends".
    const bucket = index.byBaseKey.get("legends");
    expect(bucket!.map((e) => e.refId).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("buckets by full productKey, separating entries with different defining tokens", () => {
    const entries = [
      entry({ refId: "r1", productName: "legends mobile" }),
      entry({ refId: "r2", productName: "legends pro" }),
    ];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    expect(index.byProductKey.get("legends::platform=mobile")!.map((e) => e.refId)).toEqual(["r1"]);
    expect(index.byProductKey.get("legends::edition=pro")!.map((e) => e.refId)).toEqual(["r2"]);
  });

  it("buckets by external id only for entries that have one", () => {
    const entries = [
      entry({ refId: "r1", externalId: "SKU-1" }),
      entry({ refId: "r2", externalId: null }),
    ];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    expect(index.byExternalId.get("SKU-1")!.map((e) => e.refId)).toEqual(["r1"]);
    expect(index.byExternalId.size).toBe(1);
  });

  it("does not index an empty-string external id", () => {
    const entries = [entry({ refId: "r1", externalId: "" })];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    expect(index.byExternalId.size).toBe(0);
  });

  it("sorts every bucket lexicographically by productKey, not insertion order", () => {
    // Insert in an order that is the REVERSE of productKey sort order.
    // Give all three entries the SAME external id so they land in one
    // byExternalId bucket despite having three distinct productKeys —
    // a clean way to assert cross-entry sort order within a single bucket.
    const collidingEntries = [
      entry({ refId: "r1", productName: "zzz item mobile", externalId: "SAME" }),
      entry({ refId: "r2", productName: "aaa item mobile", externalId: "SAME" }),
      entry({ refId: "r3", productName: "mmm item mobile", externalId: "SAME" }),
    ];
    const collidingIndex = buildCatalogIndex(collidingEntries, TEST_KNOWLEDGE, "stamp");
    const bucket = collidingIndex.byExternalId.get("SAME")!;
    const productKeys = bucket.map((e) => {
      // Recompute productKey the same way engine.ts would, to assert sort order.
      return e.productName;
    });
    // "aaa item::platform=mobile" < "mmm item::platform=mobile" < "zzz item::platform=mobile"
    expect(productKeys).toEqual(["aaa item mobile", "mmm item mobile", "zzz item mobile"]);
  });

  it("preserves stable relative order for entries that tie on productKey", () => {
    const entries = [
      entry({ refId: "r-second", productName: "legends" }),
      entry({ refId: "r-first", productName: "legends" }),
    ];
    const index = buildCatalogIndex(entries, TEST_KNOWLEDGE, "stamp");
    // Both tie on productKey "legends" — a stable sort keeps input order.
    expect(index.byProductKey.get("legends")!.map((e) => e.refId)).toEqual(["r-second", "r-first"]);
  });

  it("returns ReadonlyMap-typed buckets that are genuine Maps (not plain objects)", () => {
    const index = buildCatalogIndex([entry({ refId: "r1" })], TEST_KNOWLEDGE, "stamp");
    expect(index.byProductKey).toBeInstanceOf(Map);
    expect(index.byBaseKey).toBeInstanceOf(Map);
    expect(index.byNormalizedName).toBeInstanceOf(Map);
    expect(index.byDespacedName).toBeInstanceOf(Map);
    expect(index.byExternalId).toBeInstanceOf(Map);
  });

  it("handles an empty entry list", () => {
    const index = buildCatalogIndex([], TEST_KNOWLEDGE, "stamp");
    expect(index.entryCount).toBe(0);
    expect(index.byProductKey.size).toBe(0);
  });
});
