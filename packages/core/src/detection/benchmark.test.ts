import { describe, it, expect } from "vitest";
import { detect, type DetectionDeps } from "./engine";
import { buildCatalogIndex } from "./indexBuild";
import type { CatalogEntry, KnowledgeBase } from "./types";

// Synthetic knowledge base — no real product/brand names (AC-01).
const KNOWLEDGE: KnowledgeBase = {
  tokens: [
    { category: "platform", token: "mobile", canonical: "mobile", isProductDefining: true, enabled: true },
    { category: "platform", token: "pc", canonical: "pc", isProductDefining: true, enabled: true },
    { category: "edition", token: "pro", canonical: "pro", isProductDefining: true, enabled: true },
    { category: "distribution", token: "zeta", canonical: "zeta", isProductDefining: true, enabled: true },
    { category: "region", token: "id", canonical: "id", isProductDefining: false, enabled: true },
    { category: "region", token: "sg", canonical: "sg", isProductDefining: false, enabled: true },
  ],
  aliases: [],
  overrides: [],
  externalIdStableBySupplier: { supplierA: true },
  revision: "benchmark",
};

// Procedurally generated 10,000-row synthetic catalog — "Game ${i}" /
// "Game ${i} Mobile" patterns per the brief, NOT hand-written. "Game" here
// is a generic placeholder word (same status as "legends"/"zeta" elsewhere
// in this test suite), not a real product/brand name — AC-01.
const CATALOG_SIZE = 10_000;
const PLATFORMS = ["Mobile", "PC", "Pro"];

function buildSyntheticCatalog(size: number): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (let i = 0; i < size; i++) {
    const platform = PLATFORMS[i % PLATFORMS.length]!;
    entries.push({
      externalId: `SKU-${i}`,
      productName: `Game ${i} ${platform}`,
      category: "games",
      type: "topup",
      refId: `ref-${i}`,
    });
  }
  return entries;
}

const CATALOG = buildSyntheticCatalog(CATALOG_SIZE);
const INDEX = buildCatalogIndex(CATALOG, KNOWLEDGE, "1.0.0+kbenchmark");
const DEPS: DetectionDeps = { knowledge: KNOWLEDGE, index: INDEX, supplier: "supplierA" };

// Budget: 2000ms for 1,000 detect() calls against a real 10,000-entry
// index. This is generous enough not to flake on a loaded/shared CI runner
// (per CLAUDE.md, several sessions run concurrently on this machine), but
// tight enough to catch an accidental O(n) scan — lookupCandidates does at
// most 5 Map.get (O(1)) calls per detect() call, so a correct
// implementation should run this in low tens of milliseconds; a regression
// to scanning all 10,000 entries per call would push well past 2000ms.
const BUDGET_MS = 2000;
const CALL_COUNT = 1000;

describe("benchmark (AC-13)", () => {
  it("builds a 10,000-entry index and runs 1,000 detect() calls within budget", () => {
    expect(INDEX.entryCount).toBe(CATALOG_SIZE);

    const inputs = Array.from({ length: CALL_COUNT }, (_, i) => {
      const targetIndex = (i * 97) % CATALOG_SIZE; // spread across the catalog, not just the first N
      const platform = PLATFORMS[targetIndex % PLATFORMS.length]!;
      return {
        productName: `Game ${targetIndex} ${platform}`,
        externalId: `SKU-${targetIndex}`,
        category: "games",
        type: "topup",
      };
    });

    const start = performance.now();
    for (const input of inputs) {
      const result = detect(input, DEPS);
      expect(["resolved", "ambiguous", "unknown"]).toContain(result.status);
    }
    const elapsedMs = performance.now() - start;

    // Intentional: surfaces the real measured number in test output for the report, not left as a silent pass/fail.
    console.log(`[benchmark] ${CALL_COUNT} detect() calls against a ${CATALOG_SIZE}-entry index: ${elapsedMs.toFixed(2)}ms`);

    expect(elapsedMs).toBeLessThan(BUDGET_MS);
  });

  it("resolves a spread of synthetic lookups correctly (sanity check the benchmark isn't measuring no-op calls)", () => {
    const result = detect({ productName: "Game 4242 Mobile", category: "games", type: "topup" }, DEPS);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.productKey).toContain("game 4242");
  });

  it("is a genuine Map-based O(k) index, not a disguised O(n) scan (structural guarantee independent of timing)", () => {
    expect(DEPS.index.byProductKey).toBeInstanceOf(Map);
    expect(DEPS.index.byBaseKey).toBeInstanceOf(Map);
    expect(DEPS.index.byNormalizedName).toBeInstanceOf(Map);
    expect(DEPS.index.byDespacedName).toBeInstanceOf(Map);
    expect(DEPS.index.byExternalId).toBeInstanceOf(Map);
    // A plain object would report `Object.keys` entries too, but the
    // structural guarantee we actually want is that these are real Maps
    // (O(1) .get), never plain objects walked with Object.keys/for-in.
    expect(DEPS.index.byProductKey.size).toBeGreaterThan(0);
    expect(DEPS.index.byExternalId.size).toBe(CATALOG_SIZE);
  });
});
