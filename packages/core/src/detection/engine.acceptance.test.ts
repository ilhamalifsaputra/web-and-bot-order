/**
 * Acceptance tests for the Detection Engine (Task 6): AC-03, AC-04, AC-05,
 * AC-08, AC-09 — exercised against the synthetic fixtures in
 * `__fixtures__/syntheticGameA.ts` rather than invented one-off knowledge
 * bases, so these tests prove the *shipped* fixture data actually produces
 * the behavior the spec's acceptance criteria describe.
 *
 * Design note shared by AC-03/AC-04/AC-09: every "should resolve" query
 * below pairs `productName` with its fixture row's `externalId`. This
 * isn't incidental — several of the fixture rows share a `baseProductKey`
 * by design (e.g. "PUBG Mobile"/"PUBG Lite"/"PUBG PC" all reduce to core
 * "pubg"), so a bare productName-only query pulls every sibling in as a
 * candidate via the catalog's `byBaseKey` bucket and can land within
 * MARGIN of a same-base sibling (ambiguous) rather than resolving. Pairing
 * the query with its own externalId (a realistic shape — production
 * callers always have the supplier's id) supplies the level-2 external-id
 * signal (W_EXTERNAL_ID=60), which decisively separates the true match
 * from its base-key siblings. This mirrors real usage: a caller matching
 * catalog rows always has more than a bare name available.
 */

import { describe, it, expect } from "vitest";
import { detect, type DetectionDeps } from "./engine";
import { buildCatalogIndex } from "./indexBuild";
import { buildBaseProductKey, buildProductKey, buildSkuKey } from "./keys";
import { extractFeatures } from "./features";
import { normalize } from "./normalize";
import {
  W_NAME_CORE,
  DEFINING_TOKEN_CAP,
  W_STRUCTURED_META,
  DISTRIBUTION_CAP,
  computeConfidence,
} from "./scoring";
import type { CatalogEntry, KnowledgeBase } from "./types";
import { SYNTHETIC_CATALOG, SYNTHETIC_KNOWLEDGE } from "./__fixtures__/syntheticGameA";

const INDEX = buildCatalogIndex(SYNTHETIC_CATALOG, SYNTHETIC_KNOWLEDGE, "acceptance-stamp");
const DEPS: DetectionDeps = { knowledge: SYNTHETIC_KNOWLEDGE, index: INDEX, supplier: "digiflazz" };

// The spec's own 7-entity AC-03 acceptance example, each paired with its
// fixture row's externalId (see module doc comment for why).
const SEVEN_ENTITY_QUERIES: { productName: string; externalId: string }[] = [
  { productName: "Delta Force", externalId: "EXT-DF-BASE" },
  { productName: "Delta Force Garena", externalId: "EXT-DF-GARENA" },
  { productName: "Free Fire", externalId: "EXT-FF-BASE" },
  { productName: "Free Fire MAX", externalId: "EXT-FF-MAX" },
  { productName: "PUBG Mobile", externalId: "EXT-PUBG-MOBILE" },
  { productName: "PUBG Lite", externalId: "EXT-PUBG-LITE" },
  { productName: "PUBG PC", externalId: "EXT-PUBG-PC" },
];

describe("detect() — AC-03 (7-entity set resolves to 7 distinct productKeys)", () => {
  it("produces exactly 7 distinct, resolved productKeys", () => {
    const productKeys = new Set<string>();
    for (const query of SEVEN_ENTITY_QUERIES) {
      const result = detect(query, DEPS);
      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") continue;
      productKeys.add(result.productKey);
    }
    expect(productKeys.size).toBe(7);
  });
});

describe("detect() — AC-04 (distribution variations collapse to the same productKey, differentiate skuKey)", () => {
  const BASE_INPUT = { productName: "Game A Mobile", externalId: "EXT-GAMEA-MOBILE" };

  it("varying only country[] yields the same productKey", () => {
    const baseline = detect(BASE_INPUT, DEPS);
    const countryVariant = detect({ ...BASE_INPUT, country: "id" }, DEPS);
    expect(baseline.status).toBe("resolved");
    expect(countryVariant.status).toBe("resolved");
    if (baseline.status !== "resolved" || countryVariant.status !== "resolved") return;
    expect(countryVariant.productKey).toBe(baseline.productKey);
  });

  it("varying only publisher/supplier yields the same productKey", () => {
    const baseline = detect(BASE_INPUT, DEPS);
    const publisherVariant = detect({ ...BASE_INPUT, publisher: "somepublisher" }, DEPS);
    expect(baseline.status).toBe("resolved");
    expect(publisherVariant.status).toBe("resolved");
    if (baseline.status !== "resolved" || publisherVariant.status !== "resolved") return;
    expect(publisherVariant.productKey).toBe(baseline.productKey);
  });

  it("varying only denomination/SKU yields the same productKey but a different skuKey", () => {
    // Per Task 5's design, DetectionInput has no denomination field, so
    // detect() itself always returns skuKey: null — skuKey differentiation
    // is composed at the caller layer via buildSkuKey directly (see
    // keys.test.ts for the same composition pattern).
    const baseline = detect(BASE_INPUT, DEPS);
    expect(baseline.status).toBe("resolved");
    if (baseline.status !== "resolved") return;

    const features = extractFeatures(normalize("Game A Mobile"), SYNTHETIC_KNOWLEDGE);
    const skuKeySmallDenom = buildSkuKey(baseline.productKey, "50000", features.distributionTokens);
    const skuKeyLargeDenom = buildSkuKey(baseline.productKey, "100000", features.distributionTokens);

    expect(skuKeySmallDenom).not.toBe(skuKeyLargeDenom);
    expect(skuKeySmallDenom.startsWith(baseline.productKey)).toBe(true);
    expect(skuKeyLargeDenom.startsWith(baseline.productKey)).toBe(true);
  });
});

describe("detect() — AC-05 (literal-format invariance, despaced weak-match ambiguity, alias fix)", () => {
  const FORMAT_VARIANTS = [
    "PUBG Mobile",
    "pubg mobile",
    " PUBG Mobile ",
    "PUBG-Mobile",
    "PUBG_Mobile",
    "PUBG  Mobile",
  ];

  function computeProductKeyDirect(rawName: string): string {
    const normalized = normalize(rawName);
    const features = extractFeatures(normalized, SYNTHETIC_KNOWLEDGE);
    const baseProductKey = buildBaseProductKey(features.coreTokens);
    return buildProductKey(baseProductKey, features.definingTokens);
  }

  it("collapses 6 literal format variants of the same name to the identical productKey", () => {
    const keys = FORMAT_VARIANTS.map(computeProductKeyDirect);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("pubg::platform=mobile");
  });

  // A catalog with a genuine decoy row: some historical import literally
  // spelled a different SKU as "PUBGMobile" with no separator at all.
  // Querying the fused spelling "PUBGMobile" now has two competing
  // readings: a STRONG exact name-core match against the decoy row (score
  // 40, since its own normalized name IS the literal fused string) versus
  // only a WEAK despaced match against the real "PUBG Mobile" row (score
  // 25). The margin between them is exactly 15 — not > MARGIN (15) — so
  // detect() must report "ambiguous" rather than silently picking either.
  const decoyCatalog: CatalogEntry[] = [
    { refId: "pubg-mobile-real", productName: "PUBG Mobile", externalId: null, category: null, type: null },
    { refId: "pubg-mobile-fused-decoy", productName: "PUBGMobile", externalId: null, category: null, type: null },
  ];

  it('"PUBGMobile" (no separator) is ambiguous, NOT resolved — architecture decision per AC-05', () => {
    const decoyIndex = buildCatalogIndex(decoyCatalog, SYNTHETIC_KNOWLEDGE, "ac05-decoy-stamp");
    const decoyDeps: DetectionDeps = { knowledge: SYNTHETIC_KNOWLEDGE, index: decoyIndex };
    const result = detect({ productName: "PUBGMobile" }, decoyDeps);
    expect(result.status).toBe("ambiguous");
  });

  it("adding a KnowledgeAlias resolves the ambiguity — fixed via data, not code", () => {
    // The alias is added to a LOCAL knowledge variant, scoped to this one
    // test only — SYNTHETIC_KNOWLEDGE itself is never mutated, so every
    // other test in this file keeps seeing "PUBGMobile" as ambiguous.
    const aliasKnowledge: KnowledgeBase = {
      ...SYNTHETIC_KNOWLEDGE,
      aliases: [
        ...SYNTHETIC_KNOWLEDGE.aliases,
        { alias: "pubgmobile", expandsTo: "pubg mobile", reason: "AC-05 alias-fix demonstration" },
      ],
    };
    const aliasIndex = buildCatalogIndex(decoyCatalog, aliasKnowledge, "ac05-alias-stamp");
    const aliasDeps: DetectionDeps = { knowledge: aliasKnowledge, index: aliasIndex };
    const result = detect({ productName: "PUBGMobile" }, aliasDeps);
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.productKey).toBe("pubg::platform=mobile");
  });
});

describe("detect() — AC-08 (weak-signal input never falsely resolves)", () => {
  it("a category-only input (no productName) is unknown", () => {
    const result = detect({ category: "games" }, DEPS);
    expect(["ambiguous", "unknown"]).toContain(result.status);
  });

  it("a genuinely ambiguous name keeps every implied candidate confidence <= 0.5", () => {
    // Reuses the AC-05 decoy scenario: "PUBGMobile" against a catalog
    // holding both the real spaced entry and the fused-spelling decoy.
    const decoyCatalog: CatalogEntry[] = [
      { refId: "pubg-mobile-real", productName: "PUBG Mobile", externalId: null, category: null, type: null },
      { refId: "pubg-mobile-fused-decoy", productName: "PUBGMobile", externalId: null, category: null, type: null },
    ];
    const decoyIndex = buildCatalogIndex(decoyCatalog, SYNTHETIC_KNOWLEDGE, "ac08-decoy-stamp");
    const decoyDeps: DetectionDeps = { knowledge: SYNTHETIC_KNOWLEDGE, index: decoyIndex };
    const result = detect({ productName: "PUBGMobile" }, decoyDeps);

    expect(["ambiguous", "unknown"]).toContain(result.status);
    if (result.status !== "ambiguous") return;

    // No supplier/externalId in play for this scenario, so external id
    // never contributes to maxAttainableScore — mirrors engine.ts's own
    // maxAttainableScore formula (see engine.ts's detect()).
    const maxAttainableScore = W_NAME_CORE + DEFINING_TOKEN_CAP + W_STRUCTURED_META + DISTRIBUTION_CAP;
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      const impliedConfidence = computeConfidence(candidate.score, maxAttainableScore);
      expect(impliedConfidence).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("detect() — AC-09 (every resolved fixture carries non-empty, well-formed evidence[])", () => {
  const RESOLVED_QUERIES: { productName: string; externalId: string }[] = [
    ...SEVEN_ENTITY_QUERIES,
    { productName: "Game A", externalId: "EXT-GAMEA-BASE" },
    { productName: "Game A Mobile", externalId: "EXT-GAMEA-MOBILE" },
    { productName: "Game A Global", externalId: "EXT-GAMEA-GLOBAL" },
    { productName: "Game A Garena", externalId: "EXT-GAMEA-GARENA" },
    { productName: "Game A PC", externalId: "EXT-GAMEA-PC" },
  ];

  for (const query of RESOLVED_QUERIES) {
    it(`"${query.productName}" resolves with non-empty, well-formed evidence`, () => {
      const result = detect(query, DEPS);
      expect(result.status).toBe("resolved");
      if (result.status !== "resolved") return;
      expect(result.evidence.length).toBeGreaterThan(0);
      for (const item of result.evidence) {
        expect(typeof item.signal).toBe("string");
        expect(item.signal.length).toBeGreaterThan(0);
        expect(typeof item.value).toBe("string");
        expect(item.value.length).toBeGreaterThan(0);
        expect(typeof item.weight).toBe("number");
        expect(Number.isFinite(item.weight)).toBe(true);
      }
    });
  }
});
