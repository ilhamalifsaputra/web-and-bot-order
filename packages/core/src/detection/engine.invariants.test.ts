import { describe, it, expect } from "vitest";
import { detect, type DetectionDeps } from "./engine";
import { buildCatalogIndex } from "./indexBuild";
import type { CatalogEntry, DetectionResult, KnowledgeBase } from "./types";

// Synthetic knowledge base — generic category words plus an invented
// distribution token ("zeta"), matching the synthetic-placeholder
// convention already established in features.test.ts/keys.test.ts (no real
// product/brand names anywhere in this file — AC-01).
const KNOWLEDGE: KnowledgeBase = {
  tokens: [
    { category: "platform", token: "mobile", canonical: "mobile", isProductDefining: true, enabled: true },
    { category: "platform", token: "pc", canonical: "pc", isProductDefining: true, enabled: true },
    { category: "edition", token: "pro", canonical: "pro", isProductDefining: true, enabled: true },
    { category: "distribution", token: "zeta", canonical: "zeta", isProductDefining: true, enabled: true },
    { category: "distribution", token: "omega", canonical: "omega", isProductDefining: true, enabled: true },
    { category: "region", token: "id", canonical: "id", isProductDefining: false, enabled: true },
    { category: "region", token: "sg", canonical: "sg", isProductDefining: false, enabled: true },
  ],
  aliases: [],
  overrides: [
    { matchKind: "normalized_name", matchValue: "override target", baseProductKey: "override target", productKey: "override target", reason: "invented test override" },
  ],
  externalIdStableBySupplier: { supplierA: true },
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

const CATALOG: CatalogEntry[] = [
  entry({ refId: "r1", productName: "legends mobile", externalId: "SKU-A", category: "games", type: "topup" }),
  entry({ refId: "r2", productName: "legends pc", externalId: "SKU-B", category: "games", type: "topup" }),
];

const INDEX = buildCatalogIndex(CATALOG, KNOWLEDGE, "1.0.0+ktest");
const DEPS: DetectionDeps = { knowledge: KNOWLEDGE, index: INDEX, supplier: "supplierA" };

describe("detect() — INV-3 total function (never throws)", () => {
  const table: { label: string; input: unknown }[] = [
    { label: "null", input: null },
    { label: "undefined", input: undefined },
    { label: "empty string", input: "" },
    { label: "number", input: 42 },
    { label: "empty object", input: {} },
    { label: "empty array", input: [] },
    { label: "numeric productName", input: { productName: 12345 } },
    { label: "object with unexpected extra fields", input: { productName: "legends mobile", foo: "bar", nested: { a: 1 }, weird: Symbol("x") } },
    { label: "emoji-only string input", input: "😀😀😀" },
    { label: "emoji-only productName field", input: { productName: "😀😀😀" } },
    { label: "10,000-character string input", input: "a".repeat(10_000) },
    { label: "10,000-character productName field", input: { productName: "a".repeat(10_000) } },
    { label: "NaN productName", input: { productName: NaN } },
    { label: "array productName", input: { productName: ["legends"] } },
    { label: "function as input", input: () => "legends" },
    { label: "circular object", input: (() => { const o: Record<string, unknown> = {}; o.self = o; return o; })() },
  ];

  for (const { label, input } of table) {
    it(`never throws for: ${label}`, () => {
      let result: DetectionResult | undefined;
      expect(() => {
        result = detect(input, DEPS);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(["resolved", "ambiguous", "unknown"]).toContain((result as { status: string }).status);
    });
  }
});

describe("detect() — AC-06 (every DetectionInput field null, individually and together)", () => {
  const fullValidInput = {
    productName: "legends mobile",
    externalId: "SKU-A",
    category: "games",
    type: "topup",
    country: "id",
    variant: "standard",
    publisher: "zeta",
  };

  for (const field of Object.keys(fullValidInput) as (keyof typeof fullValidInput)[]) {
    it(`does not throw and returns a well-typed result when only "${field}" is null`, () => {
      const input = { ...fullValidInput, [field]: null };
      let result: DetectionResult | undefined;
      expect(() => {
        result = detect(input, DEPS);
      }).not.toThrow();
      const typed = result as { status: string; reason?: string };
      expect(["resolved", "ambiguous", "unknown"]).toContain(typed.status);
      if (typed.status === "unknown") {
        expect(typeof typed.reason).toBe("string");
        expect(typed.reason!.length).toBeGreaterThan(0);
      }
    });
  }

  it("does not throw when every field is null", () => {
    const input = Object.fromEntries(Object.keys(fullValidInput).map((k) => [k, null]));
    let result: DetectionResult | undefined;
    expect(() => {
      result = detect(input, DEPS);
    }).not.toThrow();
    const typed = result as { status: string; reason?: string };
    expect(typed.status).toBe("unknown");
    expect(typeof typed.reason).toBe("string");
    expect(typed.reason!.length).toBeGreaterThan(0);
  });

  it("does not throw for an empty object and returns unknown with a human-readable reason", () => {
    let result: DetectionResult | undefined;
    expect(() => {
      result = detect({}, DEPS);
    }).not.toThrow();
    const typed = result as { status: string; reason?: string };
    expect(typed.status).toBe("unknown");
    expect(typeof typed.reason).toBe("string");
    expect(typed.reason!.length).toBeGreaterThan(0);
  });
});

describe("detect() — INV-1 determinism (1000x on genuinely conflicting scenarios)", () => {
  // Scenario 1: two candidates share the same core tokens ("legends") but
  // differ in platform ("mobile" vs "pc") — input matches core name-only,
  // no platform token, so both candidates tie exactly on score. A genuine
  // conflict: two real, differently-evidenced candidates, not a trivial
  // single-candidate case.
  const ambiguousInput = { productName: "legends", category: "games" };

  // Scenario 2: input's structured metadata (category/type) points at
  // candidate r2 more strongly via distribution, but its name-core matches
  // r1 fully — level-3 (name) should beat level-4/5 (metadata/distribution)
  // and produce a resolved result with conflicts[] populated.
  const nameVsMetadataConflictInput = { productName: "legends mobile", category: "games", type: "topup", country: "sg" };

  // Scenario 3: despaced-only weak match against a two-word core name —
  // exercises the weak name_core_despaced path (weight 25) in isolation.
  // The "id" country field doesn't overlap either candidate's name tokens,
  // so distribution contributes 0 and r2 ("legends pc") never becomes a
  // candidate at all — the resulting score (25) falls below ACCEPT_THRESHOLD
  // (40), so this scenario deterministically resolves to status "unknown".
  // No tie-breaking occurs; determinism of the "unknown" outcome (and its
  // reason string) is what's under test here.
  const despacedInput = { productName: "legendsmobile", country: "id" };

  const scenarios = [
    { label: "ambiguous tie between platform variants", input: ambiguousInput },
    { label: "name-core vs metadata/distribution conflict", input: nameVsMetadataConflictInput },
    { label: "despaced weak match scoring below threshold (unknown)", input: despacedInput },
  ];

  for (const { label, input } of scenarios) {
    it(`produces identical stringified output across 1000 runs: ${label}`, () => {
      const first = JSON.stringify(detect(input, DEPS));
      for (let i = 0; i < 1000; i++) {
        const result = JSON.stringify(detect(input, DEPS));
        expect(result).toBe(first);
      }
    });
  }
});

describe("detect() — AC-07 conflicts[]", () => {
  // A self-contained catalog for these scenarios: r1 shares the input's
  // core name (level 3), r-decoy shares nothing name-wise but gets pulled
  // into the candidate set through a bucket OTHER than name — either a
  // (coincidentally) shared external id looked up while stability is off
  // (so it never earns level-2 credit) or an unrelated product that just
  // happens to carry the same category/type/country. Both r1 and r-decoy
  // carry category "games"/type "topup" here, so they share the SAME
  // structured_meta evidence at equal weight — that signal never
  // discriminated between them, so it must NOT surface as a conflict.
  const conflictCatalog: CatalogEntry[] = [
    entry({ refId: "r1", productName: "legends mobile", externalId: "SKU-SHARED", category: "games", type: "topup" }),
    entry({ refId: "r-decoy", productName: "unrelated item", externalId: "SKU-SHARED", category: "games", type: "topup" }),
  ];
  const conflictIndex = buildCatalogIndex(conflictCatalog, KNOWLEDGE, "1.0.0+ktest");
  // No `supplier` set: external id lookup still happens (so r-decoy is
  // pulled in via the shared externalId), but isExternalIdActive is false,
  // so neither candidate scores level-2 evidence from it — r-decoy's only
  // possible evidence is its level-4 structured-metadata match, which the
  // winner also holds (see catalog comment above).
  const conflictDeps: DetectionDeps = { knowledge: KNOWLEDGE, index: conflictIndex };

  it("does not report a conflict for a signal both the winner and the loser hold at equal weight", () => {
    const input = { productName: "legends mobile", externalId: "SKU-SHARED", category: "games", type: "topup" };
    const result = detect(input, conflictDeps);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.productKey).toContain("legends");
    // r-decoy's only evidence (structured_meta) is also held by the winner
    // r1 at equal weight, so it did not discriminate between them — no
    // conflict should be reported at all.
    expect(result.conflicts).toEqual([]);
  });

  it("reports a genuine structured_meta conflict when only the loser holds the signal", () => {
    // Here r1 (the name-core winner) carries no category/type at all, so it
    // never earns structured_meta evidence — while r-decoy's category/type
    // do match the input's. This time the signal genuinely points away from
    // the winner, so it must surface as a conflict.
    const structuredMetaOnlyLoserCatalog: CatalogEntry[] = [
      entry({ refId: "r1", productName: "legends mobile", externalId: "SKU-SHARED", category: null, type: null }),
      entry({ refId: "r-decoy", productName: "unrelated item", externalId: "SKU-SHARED", category: "games", type: "topup" }),
    ];
    const structuredMetaOnlyLoserIndex = buildCatalogIndex(structuredMetaOnlyLoserCatalog, KNOWLEDGE, "1.0.0+ktest");
    const structuredMetaOnlyLoserDeps: DetectionDeps = { knowledge: KNOWLEDGE, index: structuredMetaOnlyLoserIndex };
    const input = { productName: "legends mobile", externalId: "SKU-SHARED", category: "games", type: "topup" };
    const result = detect(input, structuredMetaOnlyLoserDeps);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.productKey).toContain("legends");
    expect(result.conflicts.length).toBeGreaterThan(0);
    for (const conflict of result.conflicts) {
      expect(typeof conflict.losingSignal).toBe("string");
      expect(typeof conflict.winningSignal).toBe("string");
      expect(typeof conflict.reason).toBe("string");
      expect(conflict.reason.length).toBeGreaterThan(0);
      expect(conflict.losingSignal).toBe("structured_meta");
      // Winning ladder level must be numerically <= any level-4/5 losing
      // signal's level (lower number = stronger on this ladder).
      expect(conflict.winningLevel).toBeLessThan(4);
    }
  });

  it("constructs a second concrete conflict scenario: distribution-only evidence favors the loser", () => {
    // r-decoy shares nothing name-wise with the input, but is pulled into
    // the candidate set via the shared (unstable) external id, same as
    // above — this time its product name text happens to contain "zeta",
    // so the input's raw `publisher: "zeta"` field folds in as level-5
    // distribution evidence favoring r-decoy specifically, never r1.
    const distributionDecoyCatalog: CatalogEntry[] = [
      entry({ refId: "r1", productName: "legends mobile", externalId: "SKU-SHARED", category: null, type: null }),
      entry({ refId: "r-decoy", productName: "unrelated item zeta", externalId: "SKU-SHARED", category: null, type: null }),
    ];
    const distributionIndex = buildCatalogIndex(distributionDecoyCatalog, KNOWLEDGE, "1.0.0+ktest");
    const distributionDeps: DetectionDeps = { knowledge: KNOWLEDGE, index: distributionIndex };
    const input = { productName: "legends mobile", externalId: "SKU-SHARED", publisher: "zeta" };
    const result = detect(input, distributionDeps);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.productKey).toContain("legends");
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts.some((c) => c.losingSignal === "distribution")).toBe(true);
  });

  it("constructs a third concrete conflict scenario: one shared and one genuinely-discriminating loser against one level-3 winner", () => {
    const multiDecoyCatalog: CatalogEntry[] = [
      entry({ refId: "r1", productName: "legends mobile", externalId: "SKU-SHARED", category: "games", type: "topup" }),
      entry({ refId: "r-decoy-a", productName: "unrelated item", externalId: "SKU-SHARED", category: "games", type: "topup" }),
      entry({ refId: "r-decoy-b", productName: "second unrelated item zeta", externalId: "SKU-SHARED", category: null, type: null }),
    ];
    const multiIndex = buildCatalogIndex(multiDecoyCatalog, KNOWLEDGE, "1.0.0+ktest");
    const multiDeps: DetectionDeps = { knowledge: KNOWLEDGE, index: multiIndex };
    const input = { productName: "legends mobile", externalId: "SKU-SHARED", category: "games", type: "topup", publisher: "zeta" };
    const result = detect(input, multiDeps);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    // Both decoys share the external id (so both get pulled in as
    // candidates) but neither shares the core name. decoy-a's category/type
    // match the input the same way the winner r1's do, so its
    // structured_meta evidence is also held by the winner at equal weight —
    // that's not a genuine conflict and must be excluded. decoy-b has no
    // category/type at all, so it can only ever score via distribution
    // (the "zeta" token), which the winner does NOT hold — that IS a
    // genuine conflict.
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts.some((c) => c.losingSignal === "structured_meta")).toBe(false);
    expect(result.conflicts.some((c) => c.losingSignal === "distribution")).toBe(true);
    for (const conflict of result.conflicts) {
      expect(conflict.winningLevel).toBeLessThan(4);
    }
  });
});

describe("detect() — override short-circuit", () => {
  it("resolves via override with confidence 1 and a single evidence entry", () => {
    const result = detect({ productName: "Override Target" }, DEPS);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.confidence).toBe(1);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]!.signal).toBe("override");
    expect(result.conflicts).toEqual([]);
  });

  it("encodes the winning matchKind into the override evidence value as `${matchKind}:${matchValue}`", () => {
    const result = detect({ productName: "Override Target" }, DEPS);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.evidence[0]!.value).toBe("normalized_name:override target");
  });
});
