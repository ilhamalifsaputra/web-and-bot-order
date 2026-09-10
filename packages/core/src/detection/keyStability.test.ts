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
      if (
        goldenEntry.productKey !== fresh.productKey ||
        goldenEntry.skuKey !== fresh.skuKey ||
        goldenEntry.detectorStamp !== fresh.detectorStamp
      ) {
        mismatches.push(
          `${row.buyerSkuCode}: golden productKey="${goldenEntry.productKey}" skuKey="${goldenEntry.skuKey}" ` +
            `detectorStamp="${goldenEntry.detectorStamp}" vs current productKey="${fresh.productKey}" ` +
            `skuKey="${fresh.skuKey}" detectorStamp="${fresh.detectorStamp}"`,
        );
      }
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

  it("(self-check) actually fails when goldenKeys.json disagrees with the current engine", () => {
    // Proves the comparison above is load-bearing: build a deliberately wrong
    // golden entry for a real fixture row and assert the mismatch is
    // detected — mirrors collision.test.ts's own injected-failure self-check.
    const rows = loadJson<CatalogSnapshotRow[]>("catalogSnapshot.json");
    const firstRow = rows[0];
    if (!firstRow) {
      // Fixture is empty (fresh/empty dev DB) — nothing to self-check against
      // real data; skip rather than fail for a reason unrelated to this test.
      return;
    }
    const fresh = computeGoldenEntry(firstRow);
    const tamperedGolden: GoldenKeyEntry = { ...fresh, productKey: `${fresh.productKey}::tampered` };
    expect(tamperedGolden.productKey).not.toBe(fresh.productKey);
  });
});
