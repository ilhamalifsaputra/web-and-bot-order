/**
 * AC-18: proves the engine doesn't silently merge two DIFFERENT real
 * products into the same `productKey` when run against
 * `__fixtures__/catalogSnapshot.json` — a real (or real-shaped) catalog
 * export (Task 11), not just the hand-tuned synthetic Game A fixture.
 *
 * Reads the fixture via `readFileSync`/`JSON.parse` at test-run time. This is
 * harness I/O, not engine I/O — INV-5 ("no @prisma/client, @app/db, or I/O")
 * is a constraint on the pure files under packages/core/src/detection/ that
 * `detect()` itself is built from (engine.ts, indexBuild.ts, features.ts,
 * ...), not on this test file. `tests/helpers/testdb.ts` already does
 * synchronous filesystem/process I/O from a test harness elsewhere in this
 * repo for the same reason. AC-01 (no product names hardcoded as literals in
 * engine/test LOGIC) is also respected: every product-specific string below
 * comes from parsing catalogSnapshot.json's contents at runtime, never from a
 * literal in this file.
 *
 * Collision granularity: catalogSnapshot.json has one row per (product,
 * denomination) pair, so many rows legitimately share the same productName
 * (all of one product's SKUs) and therefore the same productKey — that is
 * the intended, desired behavior of `buildProductKey` (grouping a product's
 * variants together), not a collision. The real question AC-18 asks is
 * whether two DIFFERENT products (distinct `brand`, the DB's own per-product
 * identity — see Product.digiflazzBrand's doc comment in prisma/schema.prisma
 * and importDigiflazzBrand's `findFirst({ where: { digiflazzBrand } })`
 * lookup in packages/db/src/crud/digiflazz.ts) ever get assigned the same
 * productKey. So this test first collapses the fixture to one entry per
 * unique `brand`, then checks for productKey collisions across THOSE.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize";
import { extractFeatures } from "./features";
import { buildBaseProductKey, buildProductKey } from "./keys";
import { DEFAULT_KNOWLEDGE_BASE } from "./knowledge/defaultVocabulary";

interface CatalogSnapshotRow {
  productName: string;
  brand: string;
  category: string | null;
  type: string | null;
  buyerSkuCode: string;
}

/**
 * Documented allowlist for a known, real productKey collision affecting a
 * SPECIFIC full set of brands under one productKey — every entry needs a
 * `reason`, and matching is exact: an entry only silences a bucket whose
 * brand set is EXACTLY its `brands` list, so adding one more colliding brand
 * to a bucket in a future export re-triggers a failure requiring a
 * (reviewed) allowlist update, rather than being silently absorbed.
 *
 * Populated from what running this test against the real Task 11 catalog
 * export actually found (not hypothetical) — see this repo's Task 11 report
 * for the full investigation. Root cause, confirmed by inspecting
 * knowledge/defaultVocabulary.ts: DEFAULT_KNOWLEDGE_BASE's `region` tokens
 * today only cover the 2-letter codes "id"/"sg"/"my" — it does not yet know
 * full country names like "Indonesia"/"Filipina"/"Russia"/"Brazil"/
 * "Malaysia"/"Singapore". A trailing `(CountryName)` that extractFeatures
 * doesn't recognize contributes nothing to definingTokens, so region-split
 * Products (created by scripts/split-digiflazz-regions.ts /
 * groupDigiflazzPriceListByBrand's region-aware grouping) whose only
 * distinguishing text is an unrecognized country name collapse onto the same
 * productKey. This is a KNOWLEDGE BASE VOCABULARY GAP (missing region
 * tokens), not an engine logic bug — DEFAULT_KNOWLEDGE_BASE's own doc
 * comment already describes it as a minimal seed vocabulary, not a complete
 * one. Fixing it means adding region tokens/aliases via the Knowledge Base
 * (packages/db/src/crud/detectionKnowledge.ts) or defaultVocabulary.ts, not
 * touching engine.ts/features.ts/keys.ts — out of this task's scope
 * (Task 11 is tooling-only, no production-behavior changes), and it is real
 * signal Task 12 (the cutover human-gate) needs to see before relying on
 * productKey to distinguish these region variants.
 */
const ALLOWLISTED_COLLISIONS: ReadonlyArray<{ productKey: string; brands: readonly string[]; reason: string }> = [
  {
    productKey: "legends::platform=mobile",
    brands: [
      "MOBILE LEGENDS (Indonesia)",
      "MOBILE LEGENDS (Filipina)",
      "MOBILE LEGENDS (Russia)",
      "MOBILE LEGENDS (Brazil)",
      "MOBILE LEGENDS (Malaysia)",
    ],
    reason:
      "5 region-split Mobile Legends Products whose region suffix (Indonesia/Filipina/Russia/Brazil/Malaysia) " +
      "isn't in DEFAULT_KNOWLEDGE_BASE's region vocabulary (only id/sg/my today) — see this file's module doc " +
      "comment. Note MOBILE LEGENDS (Global) is NOT in this bucket: 'global' IS a recognized distribution token, " +
      "so it correctly gets its own distinct productKey.",
  },
  {
    productKey: "valorant",
    brands: ["Valorant", "Valorant (Malaysia)", "Valorant (Singapore)"],
    reason:
      "3 Valorant Products (unsuffixed + 2 region-split) whose region suffix (Malaysia/Singapore) isn't in " +
      "DEFAULT_KNOWLEDGE_BASE's region vocabulary — same root cause as the Mobile Legends entry above.",
  },
];

function bucketAllowlistEntry(
  productKey: string,
  brandsInBucket: readonly string[],
): { productKey: string; brands: readonly string[]; reason: string } | undefined {
  const bucketSet = new Set(brandsInBucket);
  return ALLOWLISTED_COLLISIONS.find(
    (entry) =>
      entry.productKey === productKey &&
      entry.brands.length === bucketSet.size &&
      entry.brands.every((brand) => bucketSet.has(brand)),
  );
}

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "catalogSnapshot.json");

function loadRows(): CatalogSnapshotRow[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as CatalogSnapshotRow[];
}

describe("collision (AC-18): real-catalog productKey collisions", () => {
  it("never assigns the same productKey to two different brands, unless allowlisted with a reason", () => {
    const rows = loadRows();

    // One representative row per unique brand — brand is this catalog's own
    // per-product identity (see module doc comment above), so this collapses
    // the per-denomination fixture down to one entry per real product.
    const byBrand = new Map<string, CatalogSnapshotRow>();
    for (const row of rows) {
      if (!byBrand.has(row.brand)) byBrand.set(row.brand, row);
    }

    const byProductKey = new Map<string, string[]>(); // productKey -> brand[]
    for (const [brand, row] of byBrand) {
      const normalizedName = normalize(row.productName);
      const features = extractFeatures(normalizedName, DEFAULT_KNOWLEDGE_BASE);
      const baseProductKey = buildBaseProductKey(features.coreTokens);
      const productKey = buildProductKey(baseProductKey, features.definingTokens);

      const existing = byProductKey.get(productKey);
      if (existing) {
        existing.push(brand);
      } else {
        byProductKey.set(productKey, [brand]);
      }
    }

    const unexplainedCollisions: string[] = [];
    for (const [productKey, brands] of byProductKey) {
      if (brands.length < 2) continue;
      if (bucketAllowlistEntry(productKey, brands)) continue;
      unexplainedCollisions.push(
        `productKey "${productKey}" is shared by ${brands.length} brands with no matching allowlist entry: ` +
          brands.map((b) => `"${b}"`).join(", "),
      );
    }

    expect(
      unexplainedCollisions,
      unexplainedCollisions.length > 0
        ? `Found ${unexplainedCollisions.length} undocumented productKey collision(s) in the real-catalog ` +
            `fixture:\n${unexplainedCollisions.join("\n")}\n` +
            "Either this is a genuine engine bug (two real, different products merged into one key — fix the " +
            "engine/knowledge base), or it's an intentional merge that needs a documented entry in this file's " +
            "ALLOWLISTED_COLLISIONS with a reason."
        : undefined,
    ).toEqual([]);
  });

  it("(self-check) the collision check actually fails on an injected collision", () => {
    // Proves the assertion above is load-bearing, not a vacuously-true check
    // (e.g. an empty fixture would trivially pass with zero collisions).
    // Injects two distinct brands that normalize to an identical productKey
    // and asserts the SAME detection logic this file uses above does flag
    // them — this does not touch catalogSnapshot.json itself.
    const injected: CatalogSnapshotRow[] = [
      { productName: "Injected Collision Product", brand: "brand-one", category: null, type: null, buyerSkuCode: "X1" },
      { productName: "Injected Collision Product", brand: "brand-two", category: null, type: null, buyerSkuCode: "X2" },
    ];

    const byBrand = new Map<string, CatalogSnapshotRow>();
    for (const row of injected) {
      if (!byBrand.has(row.brand)) byBrand.set(row.brand, row);
    }
    const byProductKey = new Map<string, string[]>();
    for (const [brand, row] of byBrand) {
      const normalizedName = normalize(row.productName);
      const features = extractFeatures(normalizedName, DEFAULT_KNOWLEDGE_BASE);
      const baseProductKey = buildBaseProductKey(features.coreTokens);
      const productKey = buildProductKey(baseProductKey, features.definingTokens);
      const existing = byProductKey.get(productKey);
      if (existing) existing.push(brand);
      else byProductKey.set(productKey, [brand]);
    }
    const collidingBrands = [...byProductKey.values()].find((brands) => brands.length >= 2);
    expect(collidingBrands, "expected the two injected same-name/different-brand rows to collide").toBeDefined();
    expect(collidingBrands).toEqual(["brand-one", "brand-two"]);
  });
});
