/**
 * Task 12b: proves the engine doesn't silently assign the SAME `skuKey` to
 * two DIFFERENT (product, denomination) pairs when two or more real
 * Products collapse onto the same `productKey` — the gap identified at the
 * Task 12 human gate (see collision.test.ts's ALLOWLISTED_COLLISIONS doc
 * comment and `.superpowers/sdd/task-11-report.md`'s "Known Gap" section).
 *
 * Background: `buildProductKey` intentionally collapses region-split
 * Products (e.g. "MOBILE LEGENDS (Indonesia)" / "(Filipina)" / "(Russia)" /
 * "(Brazil)" / "(Malaysia)") onto ONE productKey — that's AC-04's correct,
 * desired coarseness (region is `isProductDefining: false` by design).
 * Differentiation between those region variants is supposed to happen at the
 * `skuKey` level via `distributionTokens`
 * (`buildSkuKey(productKey, denomination, distributionTokens)`,
 * packages/core/src/detection/keys.ts). Production's real call site
 * (`writeShadowDetectionForImport`, packages/db/src/crud/digiflazz.ts) feeds
 * the DENOMINATION DISPLAY NAME (e.g. "86 Diamond"), not the buyerSkuCode,
 * into `buildSkuKey`'s `denomination` argument — and denomination names
 * legitimately repeat across a game's region variants (e.g. "Mobile Legends
 * Weekly Diamond Pass" is a real denomination name in all 5 of the collapsed
 * Mobile Legends Products). If `distributionTokens` doesn't actually differ
 * per region (because the region word isn't in the Knowledge Base's
 * vocabulary), two genuinely different, non-substitutable SKUs end up with
 * an identical `skuKey`.
 *
 * This test reads the SAME real-catalog fixture collision.test.ts /
 * keyStability.test.ts use (`__fixtures__/catalogSnapshot.json`, Task 11,
 * extended in Task 12b with a `denominationName` field per row — see
 * scripts/export-detection-fixture.ts's doc comment), and for every group of
 * brands that share a productKey, computes what `buildSkuKey` would actually
 * produce for every (brand, denominationName) pair using the CURRENT engine
 * (`extractFeatures`/`buildProductKey`/`buildSkuKey`) and
 * `DEFAULT_KNOWLEDGE_BASE` — not a reimplementation. `distributionTokens` are
 * computed exactly as production computes them:
 * `extractFeatures(normalize(brand), knowledge).distributionTokens`
 * (mirrors packages/db/src/crud/digiflazz.ts's
 * `writeShadowDetectionForImport`, which passes the brand/productName, not
 * a denomination-specific string).
 *
 * Harness I/O note: same as collision.test.ts / keyStability.test.ts — this
 * file does synchronous filesystem I/O to read a JSON fixture at test-run
 * time, which is test-harness I/O, not engine I/O; INV-5 constrains the pure
 * engine files (features.ts, keys.ts, engine.ts, ...), not this test file.
 * AC-01 is respected: the only product-specific literal strings below are in
 * the documented ALLOWLISTED_SKU_KEY_COLLISIONS exception table (same
 * pattern collision.test.ts established) — everything else is parsed from
 * the fixture at runtime.
 *
 * Scope: this test only checks collisions ACROSS DIFFERENT brands that share
 * a productKey (the actual gap this task closes). It deliberately does NOT
 * flag two denominations of the SAME brand colliding on skuKey (e.g. a
 * genuine duplicate denomination name within one product) — that would be a
 * different, unrelated data-quality question, out of this task's scope.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize";
import { extractFeatures, type ExtractedFeatures } from "./features";
import { buildBaseProductKey, buildProductKey, buildSkuKey } from "./keys";
import { DEFAULT_KNOWLEDGE_BASE } from "./knowledge/defaultVocabulary";

interface CatalogSnapshotRow {
  productName: string;
  brand: string;
  category: string | null;
  type: string | null;
  buyerSkuCode: string;
  denominationName: string;
}

/**
 * Documented allowlist for a genuine residual skuKey collision: two
 * DIFFERENT brands that share a productKey AND, even after accounting for
 * region/distribution tokens, produce an identical skuKey for some
 * denomination-name pair. Matching is exact-set: an entry only silences a
 * bucket whose colliding "brand::denominationName" pair set is EXACTLY its
 * `pairs` list, so any new/changed collision re-triggers a failure requiring
 * a reviewed allowlist update rather than being silently absorbed. Each
 * entry needs a `reason` explaining why it's a genuine data anomaly (not an
 * engine bug) rather than something the vocabulary should fix.
 */
const ALLOWLISTED_SKU_KEY_COLLISIONS: ReadonlyArray<{
  skuKey: string;
  pairs: readonly string[]; // "brand::denominationName", exactly 2 entries
  reason: string;
}> = [];

function bucketAllowlistEntry(
  skuKey: string,
  pairsInBucket: readonly string[],
): { skuKey: string; pairs: readonly string[]; reason: string } | undefined {
  const bucketSet = new Set(pairsInBucket);
  return ALLOWLISTED_SKU_KEY_COLLISIONS.find(
    (entry) =>
      entry.skuKey === skuKey &&
      entry.pairs.length === bucketSet.size &&
      entry.pairs.every((pair) => bucketSet.has(pair)),
  );
}

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "catalogSnapshot.json");

function loadRows(): CatalogSnapshotRow[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as CatalogSnapshotRow[];
}

interface BrandInfo {
  brand: string;
  productKey: string;
  distributionTokens: ExtractedFeatures["distributionTokens"];
  denominationNames: string[];
}

/**
 * Collapses the per-denomination fixture rows down to one entry per unique
 * brand, computing that brand's productKey and distributionTokens exactly
 * as production does (via the real engine, on the brand/productName
 * string), and collecting the DISTINCT denomination names that brand's rows
 * carry (order-preserving, not sorted — determinism only requires stable
 * input order, not a particular sort).
 */
function buildBrandInfos(rows: CatalogSnapshotRow[]): Map<string, BrandInfo> {
  const byBrand = new Map<string, BrandInfo>();
  for (const row of rows) {
    let info = byBrand.get(row.brand);
    if (!info) {
      const normalizedName = normalize(row.productName);
      const features = extractFeatures(normalizedName, DEFAULT_KNOWLEDGE_BASE);
      const baseProductKey = buildBaseProductKey(features.coreTokens);
      const productKey = buildProductKey(baseProductKey, features.definingTokens);
      info = {
        brand: row.brand,
        productKey,
        distributionTokens: features.distributionTokens,
        denominationNames: [],
      };
      byBrand.set(row.brand, info);
    }
    if (!info.denominationNames.includes(row.denominationName)) {
      info.denominationNames.push(row.denominationName);
    }
  }
  return byBrand;
}

/**
 * For every productKey shared by 2+ distinct brands, computes the skuKey
 * every (brand, denominationName) pair would produce, and returns every
 * unexplained cross-brand collision found (skuKey shared by pairs from at
 * least two DIFFERENT brands), after subtracting anything in
 * ALLOWLISTED_SKU_KEY_COLLISIONS.
 */
function findUnexplainedSkuKeyCollisions(brandInfos: Map<string, BrandInfo>): {
  unexplained: string[];
  totalRawCollisionGroups: number;
  sharedProductKeyGroupCount: number;
} {
  const byProductKey = new Map<string, BrandInfo[]>();
  for (const info of brandInfos.values()) {
    const existing = byProductKey.get(info.productKey);
    if (existing) existing.push(info);
    else byProductKey.set(info.productKey, [info]);
  }

  const unexplained: string[] = [];
  let totalRawCollisionGroups = 0;
  let sharedProductKeyGroupCount = 0;

  for (const [, brands] of byProductKey) {
    if (brands.length < 2) continue; // no cross-brand collision possible

    sharedProductKeyGroupCount += 1;

    // skuKey -> "brand::denominationName" pairs that produced it
    const bySkuKey = new Map<string, string[]>();
    for (const info of brands) {
      for (const denominationName of info.denominationNames) {
        const skuKey = buildSkuKey(info.productKey, normalize(denominationName), info.distributionTokens);
        const pairLabel = `${info.brand}::${denominationName}`;
        const existing = bySkuKey.get(skuKey);
        if (existing) existing.push(pairLabel);
        else bySkuKey.set(skuKey, [pairLabel]);
      }
    }

    for (const [skuKey, pairs] of bySkuKey) {
      // Only a collision if the colliding pairs come from at least two
      // DIFFERENT brands — two denominations of the SAME brand sharing a
      // skuKey is out of this test's scope (see module doc comment).
      const distinctBrands = new Set(pairs.map((p) => p.split("::")[0]));
      if (distinctBrands.size < 2) continue;

      totalRawCollisionGroups += 1;
      if (bucketAllowlistEntry(skuKey, pairs)) continue;

      unexplained.push(
        `skuKey "${skuKey}" is shared by ${pairs.length} (brand, denomination) pair(s) across ` +
          `${distinctBrands.size} different brands with no matching allowlist entry: ` +
          pairs.map((p) => `"${p}"`).join(", "),
      );
    }
  }

  return { unexplained, totalRawCollisionGroups, sharedProductKeyGroupCount };
}

describe("skuKeyCollision (Task 12b): real-catalog skuKey collisions across region-collapsed products", () => {
  it("never assigns the same skuKey to a (product, denomination) pair from two different brands sharing a productKey, unless allowlisted with a reason", () => {
    const rows = loadRows();
    const brandInfos = buildBrandInfos(rows);
    const { unexplained, totalRawCollisionGroups, sharedProductKeyGroupCount } = findUnexplainedSkuKeyCollisions(brandInfos);

    // Printed unconditionally (not just on failure) so `vitest run` output
    // carries the real before/after collision count for the task report,
    // without needing a separate ad-hoc script.
    // eslint-disable-next-line no-console
    console.log(
      `[skuKeyCollision] ${totalRawCollisionGroups} raw cross-brand skuKey collision group(s) found ` +
        `(${unexplained.length} unexplained after the allowlist).`,
    );

    // Coverage guard: ensure the test examined at least one productKey group
    // with 2+ brands, so a fixture regression (e.g. every productKey becoming
    // unique) would fail loudly rather than pass vacuously.
    expect(sharedProductKeyGroupCount, "test should examine at least one multi-brand productKey group").toBeGreaterThan(0);

    expect(
      unexplained,
      unexplained.length > 0
        ? `Found ${unexplained.length} undocumented cross-brand skuKey collision(s) in the real-catalog ` +
            `fixture:\n${unexplained.join("\n")}\n` +
            "Either this is a genuine engine/knowledge gap (fix the Knowledge Base or engine), or it's a " +
            "genuine data anomaly (two different real products happen to share both region AND denomination " +
            "name) that needs a documented entry in this file's ALLOWLISTED_SKU_KEY_COLLISIONS with a reason."
        : undefined,
    ).toEqual([]);
  });

  it("(self-check) the collision check actually fails on an injected collision", () => {
    // Proves the assertion above is load-bearing, not vacuously true.
    // Injects two distinct brands with the SAME productKey (no
    // productKey-affecting tokens in either name) and the SAME denomination
    // name, and asserts the SAME logic this file uses above does flag them.
    const injected: CatalogSnapshotRow[] = [
      {
        productName: "Injected Collision Product",
        brand: "brand-one",
        category: null,
        type: null,
        buyerSkuCode: "X1",
        denominationName: "100 Gems",
      },
      {
        productName: "Injected Collision Product",
        brand: "brand-two",
        category: null,
        type: null,
        buyerSkuCode: "X2",
        denominationName: "100 Gems",
      },
    ];

    const brandInfos = buildBrandInfos(injected);
    const { unexplained } = findUnexplainedSkuKeyCollisions(brandInfos);
    expect(unexplained.length, "expected the two injected same-productKey/same-denomination rows to collide").toBe(1);
    expect(unexplained[0]).toContain("brand-one::100 Gems");
    expect(unexplained[0]).toContain("brand-two::100 Gems");
  });
});
