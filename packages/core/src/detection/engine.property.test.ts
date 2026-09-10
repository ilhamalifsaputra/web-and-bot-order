import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { detect, type DetectionDeps } from "./engine";
import { buildCatalogIndex } from "./indexBuild";
import type { CatalogEntry, DetectionResult, KnowledgeBase } from "./types";

// Synthetic knowledge base — no real product/brand names (AC-01).
const KNOWLEDGE: KnowledgeBase = {
  tokens: [
    { category: "platform", token: "mobile", canonical: "mobile", isProductDefining: true, enabled: true },
    { category: "platform", token: "pc", canonical: "pc", isProductDefining: true, enabled: true },
    { category: "edition", token: "pro", canonical: "pro", isProductDefining: true, enabled: true },
    { category: "distribution", token: "zeta", canonical: "zeta", isProductDefining: true, enabled: true },
    { category: "region", token: "id", canonical: "id", isProductDefining: false, enabled: true },
  ],
  aliases: [],
  overrides: [
    { matchKind: "normalized_name", matchValue: "override target", baseProductKey: "override target", productKey: "override target", reason: "invented test override" },
  ],
  externalIdStableBySupplier: { supplierA: true },
  revision: "test",
};

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return { externalId: null, productName: "legends", category: null, type: null, refId: "r0", ...overrides };
}

const CATALOG: CatalogEntry[] = [
  entry({ refId: "r1", productName: "legends mobile", externalId: "SKU-A", category: "games", type: "topup" }),
  entry({ refId: "r2", productName: "legends pc", externalId: "SKU-B", category: "games", type: "topup" }),
  entry({ refId: "r3", productName: "shadow realm zeta", externalId: "SKU-C", category: "voucher", type: "gift" }),
];

const INDEX = buildCatalogIndex(CATALOG, KNOWLEDGE, "1.0.0+ktest");
const DEPS: DetectionDeps = { knowledge: KNOWLEDGE, index: INDEX, supplier: "supplierA" };

// fast-check v4.9.0 has no `fc.stringOf` — use fc.string() directly (it
// already generates arbitrary-content strings including unicode/empty).
const fieldValueArb = fc.oneof(fc.string(), fc.constant(null), fc.integer(), fc.constant(undefined));

const detectionInputLikeArb = fc.record({
  productName: fieldValueArb,
  externalId: fieldValueArb,
  category: fieldValueArb,
  type: fieldValueArb,
  country: fieldValueArb,
  variant: fieldValueArb,
  publisher: fieldValueArb,
});

function isValidStatus(status: unknown): boolean {
  return status === "resolved" || status === "ambiguous" || status === "unknown";
}

describe("detect() property tests (AC-19)", () => {
  it("never throws for DetectionInput-shaped-ish random records (INV-3)", () => {
    fc.assert(
      fc.property(detectionInputLikeArb, (input) => {
        let result: DetectionResult | undefined;
        expect(() => {
          result = detect(input, DEPS);
        }).not.toThrow();
        expect(isValidStatus((result as { status: unknown }).status)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("never throws for fully arbitrary input, any shape (INV-3, true unknown-boundary coverage)", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let result: DetectionResult | undefined;
        expect(() => {
          result = detect(input, DEPS);
        }).not.toThrow();
        expect(isValidStatus((result as { status: unknown }).status)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic: detect() twice on a deep-cloned identical input yields identical stringified output (INV-1)", () => {
    fc.assert(
      fc.property(detectionInputLikeArb, (input) => {
        const clone = JSON.parse(JSON.stringify(input)) as unknown;
        const first = JSON.stringify(detect(input, DEPS));
        const second = JSON.stringify(detect(clone, DEPS));
        expect(second).toBe(first);
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic for fully arbitrary input as well (INV-1)", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        let clone: unknown;
        try {
          clone = structuredClone(input);
        } catch {
          // Not structured-cloneable (e.g. contains a function/symbol) —
          // detect() must still be deterministic on the SAME reference
          // called twice, which this still verifies.
          clone = input;
        }
        const first = JSON.stringify(detect(input, DEPS));
        const second = JSON.stringify(detect(clone, DEPS));
        expect(second).toBe(first);
      }),
      { numRuns: 200 },
    );
  });
});
