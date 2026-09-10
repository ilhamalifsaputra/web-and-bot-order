/**
 * AC-15: key stability golden-file test. For every row in the real-catalog
 * fixture (`__fixtures__/catalogSnapshot.json`, Task 11), recomputes
 * productKey/skuKey/detectorStamp with the CURRENT engine +
 * `DEFAULT_KNOWLEDGE_BASE` and compares against the checked-in
 * `__fixtures__/goldenKeys.json`.
 *
 * If this test fails, one of two things happened:
 *   1. Your change unintentionally altered key computation — a real
 *      regression. Fix it.
 *   2. You intended to change key computation (e.g. a deliberate knowledge
 *      base or scoring change) — regenerate the golden file via
 *      `pnpm exec tsx scripts/recompute-detection-keys.ts --apply`, REVIEW
 *      the printed diff to confirm every change is expected, and commit the
 *      regenerated `goldenKeys.json` alongside your change.
 *
 * Reads both fixture files via `readFileSync`/`JSON.parse` at test-run time
 * — harness I/O, not engine I/O (see collision.test.ts's identical note on
 * INV-5's actual scope, and tests/helpers/testdb.ts's own precedent for
 * synchronous I/O in a test harness). AC-01 is respected: no product name is
 * ever a literal in this file's logic, only data parsed from the fixture
 * files at runtime.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize";
import { extractFeatures } from "./features";
import { buildBaseProductKey, buildProductKey, buildSkuKey } from "./keys";
import { buildDetectorStamp } from "./version";
import { DEFAULT_KNOWLEDGE_BASE } from "./knowledge/defaultVocabulary";

interface CatalogSnapshotRow {
  productName: string;
  brand: string;
  category: string | null;
  type: string | null;
  buyerSkuCode: string;
}

interface GoldenKeyEntry {
  buyerSkuCode: string;
  productKey: string;
  skuKey: string;
  detectorStamp: string;
}

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function loadJson<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, fileName), "utf-8")) as T;
}

/** Mirrors scripts/recompute-detection-keys.ts's computeGoldenEntry exactly
 * (kept as an independent copy, not a shared import, so this test and that
 * script can never both hide the same bug from each other — see that
 * script's own doc comment). */
function computeGoldenEntry(row: CatalogSnapshotRow): GoldenKeyEntry {
  const normalizedName = normalize(row.productName);
  const features = extractFeatures(normalizedName, DEFAULT_KNOWLEDGE_BASE);
  const baseProductKey = buildBaseProductKey(features.coreTokens);
  const productKey = buildProductKey(baseProductKey, features.definingTokens);
  const skuKey = buildSkuKey(productKey, normalize(row.buyerSkuCode), features.distributionTokens);
  const detectorStamp = buildDetectorStamp(DEFAULT_KNOWLEDGE_BASE.revision);
  return { buyerSkuCode: row.buyerSkuCode, productKey, skuKey, detectorStamp };
}

/**
 * The SAME comparison the main test below uses to decide whether a freshly
 * computed entry drifted from its golden counterpart. Both the main test and
 * the "(self-check)" test call this one function — not two independently
 * written checks — so a real regression in the comparison logic itself
 * (e.g. someone "fixing" this to always return null) is caught by the
 * self-check too, not just by the main assertion.
 */
function compareToGolden(fresh: GoldenKeyEntry, goldenEntry: GoldenKeyEntry): string | null {
  if (
    goldenEntry.productKey !== fresh.productKey ||
    goldenEntry.skuKey !== fresh.skuKey ||
    goldenEntry.detectorStamp !== fresh.detectorStamp
  ) {
    return (
      `${fresh.buyerSkuCode}: golden productKey="${goldenEntry.productKey}" skuKey="${goldenEntry.skuKey}" ` +
      `detectorStamp="${goldenEntry.detectorStamp}" vs current productKey="${fresh.productKey}" ` +
      `skuKey="${fresh.skuKey}" detectorStamp="${fresh.detectorStamp}"`
    );
  }
  return null;
}

describe("keyStability (AC-15): productKey/skuKey golden file", () => {
  it("matches goldenKeys.json for every row of the real-catalog fixture", () => {
    const rows = loadJson<CatalogSnapshotRow[]>("catalogSnapshot.json");
    const golden = loadJson<GoldenKeyEntry[]>("goldenKeys.json");
    const goldenBySku = new Map(golden.map((entry) => [entry.buyerSkuCode, entry]));

    expect(golden.length, "goldenKeys.json must have one entry per catalogSnapshot.json row").toBe(rows.length);

    const mismatches: string[] = [];
    for (const row of rows) {
      const fresh = computeGoldenEntry(row);
      const goldenEntry = goldenBySku.get(row.buyerSkuCode);
      if (!goldenEntry) {
        mismatches.push(`${row.buyerSkuCode}: missing from goldenKeys.json`);
        continue;
      }
      const mismatch = compareToGolden(fresh, goldenEntry);
      if (mismatch) mismatches.push(mismatch);
    }

    expect(
      mismatches,
      mismatches.length > 0
        ? `${mismatches.length} key(s) drifted from goldenKeys.json:\n${mismatches.join("\n")}\n\n` +
            "If this is an unintentional regression, fix the engine/knowledge change that caused it. If it's " +
            "intentional, run `pnpm exec tsx scripts/recompute-detection-keys.ts --apply`, review the diff, and " +
            "commit the regenerated goldenKeys.json alongside your change."
        : undefined,
    ).toEqual([]);
  });

  it("(self-check) compareToGolden actually detects a real mismatch", () => {
    // Proves compareToGolden — the SAME comparison function the main test
    // above calls — is load-bearing, not vacuously true. Rather than
    // tampering a string and asserting two different strings differ (true
    // by construction, and doesn't exercise compareToGolden at all), this
    // computes row A's CURRENT key normally, then compares it against a
    // DIFFERENT real fixture row's stored golden entry — a genuine,
    // realistic mismatch — and asserts compareToGolden reports it.
    const rows = loadJson<CatalogSnapshotRow[]>("catalogSnapshot.json");
    const golden = loadJson<GoldenKeyEntry[]>("goldenKeys.json");
    if (rows.length < 2 || golden.length < 2) {
      // Fixture too small (fresh/empty dev DB) to pick two distinct rows —
      // nothing meaningful to self-check against; skip rather than fail for
      // a reason unrelated to this test.
      return;
    }

    const rowA = rows[0]!;
    const freshA = computeGoldenEntry(rowA);

    // Pick another row's golden entry whose stored productKey genuinely
    // differs from freshA's, so this is guaranteed to be a real mismatch —
    // not an accidental pass because two different buyerSkuCodes happen to
    // share the same product's productKey.
    const mismatchedGolden = golden.find(
      (entry) => entry.buyerSkuCode !== rowA.buyerSkuCode && entry.productKey !== freshA.productKey,
    );
    if (!mismatchedGolden) {
      // Every other row happens to share row A's productKey (fixture has
      // only one distinct product) — nothing to self-check against; skip.
      return;
    }

    const result = compareToGolden(freshA, mismatchedGolden);
    expect(result, "expected compareToGolden to detect two genuinely different rows' keys as a mismatch").not.toBeNull();
  });
});
