/**
 * Recomputes productKey/skuKey/detectorStamp for every row in
 * `packages/core/src/detection/__fixtures__/catalogSnapshot.json` using the
 * CURRENT engine + `DEFAULT_KNOWLEDGE_BASE`, and diffs the result against the
 * checked-in `packages/core/src/detection/__fixtures__/goldenKeys.json`.
 *
 * Dry-run by default (matches scripts/split-digiflazz-regions.ts's
 * convention: prints the diff, writes nothing) — only `--apply` overwrites
 * `goldenKeys.json`.
 *
 *   pnpm exec tsx scripts/recompute-detection-keys.ts            # dry run — prints the diff, writes nothing
 *   pnpm exec tsx scripts/recompute-detection-keys.ts --apply    # regenerates goldenKeys.json
 *
 * This is the tool `keyStability.test.ts`'s own doc comment points to: if
 * that test fails because you intentionally changed key computation, run
 * this with `--apply` and review the printed diff BEFORE committing the
 * regenerated `goldenKeys.json` alongside your change.
 *
 * Pure recomputation only — never touches a database, never imports
 * @prisma/client or @app/db. Standalone; never runs as part of `pretest`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalize } from "@app/core/detection";
import { extractFeatures } from "@app/core/detection";
import { buildBaseProductKey, buildProductKey, buildSkuKey } from "@app/core/detection";
import { buildDetectorStamp } from "@app/core/detection";
import { DEFAULT_KNOWLEDGE_BASE } from "@app/core/detection/knowledge";

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

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "packages",
  "core",
  "src",
  "detection",
  "__fixtures__",
);
const SNAPSHOT_PATH = join(FIXTURES_DIR, "catalogSnapshot.json");
const GOLDEN_PATH = join(FIXTURES_DIR, "goldenKeys.json");

const USAGE = `Recompute productKey/skuKey/detectorStamp for the real-catalog fixture and diff against goldenKeys.json.

Usage:
  pnpm exec tsx scripts/recompute-detection-keys.ts            # dry run (default) — prints the diff, writes nothing
  pnpm exec tsx scripts/recompute-detection-keys.ts --apply    # writes packages/core/src/detection/__fixtures__/goldenKeys.json

Options:
  --apply       Actually overwrite goldenKeys.json (default: dry run only).
  --help, -h    Show this help.

Run this after a deliberate engine/knowledge change that alters key computation, review the printed
diff, then commit the regenerated goldenKeys.json alongside that change.
`;

/** Same key-computation shape keyStability.test.ts uses — kept as an
 * independent, small implementation here (not imported from the test file)
 * so this script and that test can never accidentally share a bug that
 * masks itself from both. */
function computeGoldenEntry(row: CatalogSnapshotRow): GoldenKeyEntry {
  const normalizedName = normalize(row.productName);
  const features = extractFeatures(normalizedName, DEFAULT_KNOWLEDGE_BASE);
  const baseProductKey = buildBaseProductKey(features.coreTokens);
  const productKey = buildProductKey(baseProductKey, features.definingTokens);
  // catalogSnapshot.json carries no denomination display name (by design —
  // the export intentionally excludes it), so buyerSkuCode is the only
  // per-row differentiator available to feed buildSkuKey's `denomination`
  // argument. This mirrors writeShadowDetectionForImport's own use of
  // buildSkuKey (packages/db/src/crud/digiflazz.ts) closely enough for a
  // stability golden file: the point is detecting ANY drift in what the
  // engine computes for a fixed input, not exact production-value parity.
  const skuKey = buildSkuKey(productKey, normalize(row.buyerSkuCode), features.distributionTokens);
  const detectorStamp = buildDetectorStamp(DEFAULT_KNOWLEDGE_BASE.revision);
  return { buyerSkuCode: row.buyerSkuCode, productKey, skuKey, detectorStamp };
}

function loadSnapshot(): CatalogSnapshotRow[] {
  if (!existsSync(SNAPSHOT_PATH)) return [];
  return JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as CatalogSnapshotRow[];
}

function loadGolden(): GoldenKeyEntry[] {
  if (!existsSync(GOLDEN_PATH)) return [];
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) as GoldenKeyEntry[];
}

function sortedByBuyerSkuCode(entries: GoldenKeyEntry[]): GoldenKeyEntry[] {
  return [...entries].sort((a, b) => {
    if (a.buyerSkuCode < b.buyerSkuCode) return -1;
    if (a.buyerSkuCode > b.buyerSkuCode) return 1;
    return 0;
  });
}

function diffEntries(current: GoldenKeyEntry[], fresh: GoldenKeyEntry[]): string[] {
  const currentBySku = new Map(current.map((e) => [e.buyerSkuCode, e]));
  const freshBySku = new Map(fresh.map((e) => [e.buyerSkuCode, e]));
  const lines: string[] = [];

  for (const [sku, freshEntry] of freshBySku) {
    const currentEntry = currentBySku.get(sku);
    if (!currentEntry) {
      lines.push(`+ ${sku}: new (productKey "${freshEntry.productKey}", skuKey "${freshEntry.skuKey}")`);
      continue;
    }
    if (currentEntry.productKey !== freshEntry.productKey || currentEntry.skuKey !== freshEntry.skuKey) {
      lines.push(
        `~ ${sku}: productKey "${currentEntry.productKey}" -> "${freshEntry.productKey}", ` +
          `skuKey "${currentEntry.skuKey}" -> "${freshEntry.skuKey}"`,
      );
    }
  }
  for (const [sku, currentEntry] of currentBySku) {
    if (!freshBySku.has(sku)) {
      lines.push(`- ${sku}: removed (was productKey "${currentEntry.productKey}")`);
    }
  }
  return lines;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const unknown = argv.filter((a) => a !== "--apply");
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(", ")}\n`);
    console.log(USAGE);
    process.exit(1);
  }
  const apply = argv.includes("--apply");

  const rows = loadSnapshot();
  const fresh = sortedByBuyerSkuCode(rows.map(computeGoldenEntry));
  const current = loadGolden();

  const diffLines = diffEntries(current, fresh);

  if (!apply) {
    if (diffLines.length === 0) {
      console.log(`0 differences — goldenKeys.json (${current.length} entries) matches the current engine output.`);
    } else {
      console.log(
        `${diffLines.length} difference(s) between goldenKeys.json and the current engine output (dry run — nothing written):\n`,
      );
      for (const line of diffLines) console.log(`  ${line}`);
      console.log("\nRun again with --apply to regenerate goldenKeys.json from the current engine output.");
    }
    return;
  }

  writeFileSync(GOLDEN_PATH, `${JSON.stringify(fresh, null, 2)}\n`, "utf-8");
  console.log(`Wrote ${fresh.length} entr${fresh.length === 1 ? "y" : "ies"} to ${GOLDEN_PATH}.`);
  if (diffLines.length > 0) {
    console.log(`\n${diffLines.length} difference(s) from the previous goldenKeys.json:\n`);
    for (const line of diffLines) console.log(`  ${line}`);
  } else {
    console.log("(no differences from the previous goldenKeys.json)");
  }
}

main();
