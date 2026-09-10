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
 * engine/test LOGIC) is also respected, with one necessary exception: every
 * product-specific string below comes from parsing catalogSnapshot.json's
 * contents at runtime, EXCEPT the documented ALLOWLISTED_COLLISIONS
 * exception table below, which by necessity names the specific colliding
 * brands.
 *
 * Scope note: this test only checks `productKey` collisions on rows keyed by
 * `buyerSkuCode` (unique across the whole fixture, by construction — see
 * export-detection-fixture.ts). It does NOT check `skuKey` collisions across
 * denomination NAMES, which is production's actual key composition
 * (`buildSkuKey(productKey, normalize(denomination.name), ...)` in
 * packages/db/src/crud/digiflazz.ts, not buyerSkuCode) — see
 * `.superpowers/sdd/task-11-report.md`'s "Known Gap" section for why that
 * matters and exactly what this test (and keyStability.test.ts /
 * detection-key-diff.ts) does not catch.
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
 * for the full investigation.
 *
 * ROOT CAUSE (confirmed by reading knowledge/defaultVocabulary.ts,
 * features.ts's extractFeatures, and keys.ts's buildProductKey — an earlier
 * version of this comment mis-described this as a fixable vocabulary gap;
 * it is not): `region`-category tokens in DEFAULT_KNOWLEDGE_BASE are
 * `isProductDefining: false` BY DESIGN ("distribution-only per spec" — see
 * defaultVocabulary.ts's own inline comment). `buildProductKey` (keys.ts)
 * only serializes `definingTokens` into `productKey`; region tokens — no
 * matter how many region words are ever added to the vocabulary — are
 * structurally excluded from `productKey` and can only ever affect
 * `skuKey`/`attributes.region`. This is AC-04's INTENDED coarseness ("same
 * product, different distribution — including region — collapses to one
 * productKey, different skuKey"), not an engine bug, and NOT something a
 * vocabulary addition would fix at the productKey level.
 *
 * What actually explains these SPECIFIC rows colliding today (updated post
 * Task 12b — this paragraph previously said these region suffixes matched no
 * knowledge-base token at all; that is no longer true): the country names in
 * these brands' parenthetical suffixes ("Indonesia"/"Filipina"/"Russia"/
 * "Brazil"/"Malaysia"/"Singapore") DO now match tokens in
 * DEFAULT_KNOWLEDGE_BASE — Task 12b added them as `region`-category tokens
 * alongside the pre-existing 2-letter codes ("id"/"sg"/"my"). Being
 * classified `region`, they are `isProductDefining: false`, so
 * extractFeatures routes them into `distributionTokens`, not
 * `definingTokens` — the same net effect on `productKey` as if they had
 * never matched at all, since `buildProductKey` only serializes
 * `definingTokens`. So all of these rows still end up with an EMPTY
 * `definingTokens` list and therefore an identical `productKey` — not
 * because the words are unrecognized, but because their correctly-recognized
 * category is structurally excluded from `productKey` by design. The
 * practical upshot (and the reason Task 12b was worth doing): these tokens
 * now DO contribute to `skuKey`/`attributes.region`, which is what closed
 * the separate skuKey-collision gap below without touching `productKey`.
 * "MOBILE LEGENDS (Global)" escapes the productKey collision because
 * "global" matches a DIFFERENT knowledge-base token — category
 * `distribution`, `isProductDefining: true` — so it contributes a defining
 * pair and earns its own distinct productKey; this is unrelated to region
 * classification.
 *
 * Consequently, this productKey collision was never a vocabulary gap and
 * adding more region tokens would not change it (region tokens are
 * non-defining by design, and the tokens covering these specific brands are
 * already present as of Task 12b) — it is AC-04's intended coarseness. This
 * is real signal Task 12 (the cutover human-gate) needs to see before
 * relying on productKey to distinguish these region variants — and see this
 * file's top-of-file "Scope note" / task-11-report.md's "Known Gap" section
 * for the SEPARATE skuKey-over-denomination-name risk this test does not
 * check at all (closed for the dev fixture by `skuKeyCollision.test.ts`,
 * Task 12b).
 *
 * Headline count note: the "13 collisions" figure some earlier docs cite is
 * the number of pairwise brand COMBINATIONS across the two buckets below
 * (C(5,2) + C(3,2) = 10 + 3 = 13), not 13 separate incidents — there are
 * only 2 actual colliding productKey buckets (5-brand Mobile Legends,
 * 3-brand Valorant), matching detection-key-diff.ts's "8 products / 2
 * buckets" finding (8 = 5 + 3 disagreeing products).
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
      "5 region-split Mobile Legends Products collapse onto one productKey because their region suffixes " +
      "(Indonesia/Filipina/Russia/Brazil/Malaysia) ARE present in DEFAULT_KNOWLEDGE_BASE as 'region' tokens " +
      "(added Task 12b) but classified isProductDefining: false, so extractFeatures routes them into " +
      "distributionTokens, not definingTokens — see this file's ALLOWLISTED_COLLISIONS doc comment for the " +
      "full mechanism. This is NOT a vocabulary gap productKey would benefit from fixing: region tokens are " +
      "isProductDefining: false BY DESIGN (AC-04), so they're structurally excluded from productKey regardless " +
      "of vocabulary size — this is the intended collapsing-across-regions behavior, not a bug. Note MOBILE " +
      "LEGENDS (Global) is NOT in this bucket: 'global' matches a real knowledge-base token in the " +
      "'distribution' category with isProductDefining: true, so it correctly gets its own distinct productKey.",
  },
  {
    productKey: "valorant",
    brands: ["Valorant", "Valorant (Malaysia)", "Valorant (Singapore)"],
    reason:
      "3 Valorant Products (unsuffixed + 2 region-split) collapse onto the same productKey — same root cause " +
      "as the Mobile Legends entry above: the Malaysia/Singapore suffixes ARE present as 'region' tokens " +
      "(added Task 12b) and correctly contribute to distributionTokens, but productKey excludes them because " +
      "region tokens are isProductDefining: false by design — not because they're unrecognized vocabulary.",
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
