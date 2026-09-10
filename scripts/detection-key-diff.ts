/**
 * Task 12 (the human-gate cutover decision) tooling — NOT this task's own
 * business to interpret. Connects (read-only) to whatever DB
 * DATABASE_URL_PRISMA points at and, for every `Product` with a non-null
 * `digiflazzBrand`, compares:
 *
 *   - LEGACY grouping: `digiflazzGroupKey(brand, productName)` (the
 *     CURRENT/still-untouched-at-this-point function,
 *     @app/core/suppliers/digiflazz) applied to the Product's own
 *     `digiflazzBrand`/`name` fields — the closest available reconstruction
 *     of "what would today's brand-grouping code do with this row", since
 *     the original raw Digiflazz `{ brand, productName }` pair is not
 *     separately persisted post-import (Product.name and
 *     Product.digiflazzBrand are both already set to the grouped
 *     `displayName` by importDigiflazzBrand — see that function's own doc
 *     comment in packages/db/src/crud/digiflazz.ts). Because of that, this
 *     is a best-effort reconstruction, not a byte-exact replay of the
 *     original import decision — flagged here so Task 12 reads the table
 *     with that caveat in mind.
 *   - ENGINE grouping: the Detection Engine's `productKey`
 *     (`buildProductKey`/`buildBaseProductKey` over `Product.name`,
 *     `DEFAULT_KNOWLEDGE_BASE` — the same computation `detect()` itself uses
 *     internally, done directly here rather than through a full
 *     `CatalogIndex`, since this script only needs the key, not candidate
 *     matching).
 *
 * "Disagree on grouping" is evaluated across the WHOLE catalog, not
 * row-by-row string equality: every Product already has its own distinct
 * legacy bucket by construction (digiflazzBrand is this app's own per-
 * product dedup key — see importDigiflazzBrand's `findFirst` lookup), so the
 * only way legacy and engine grouping can actually disagree post-import is
 * if the ENGINE collapses two Products that legacy has always kept apart
 * (different digiflazzBrand) into the SAME productKey. This script's table
 * lists every such engine-side merge.
 *
 * Prints the disagreement table either way. Exit code 0 if the table is
 * empty (zero disagreements), 1 otherwise — Task 12 decides what to do with
 * that, this script only reports it.
 *
 * Read-only: a single `findMany`, never any writes, never a migration.
 * Standalone; never wired into `pretest`; never auto-run by anything else in
 * this repo.
 *
 *   pnpm exec tsx scripts/detection-key-diff.ts
 */
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, initDb } from "@app/db";
import { normalize, extractFeatures, buildBaseProductKey, buildProductKey } from "@app/core/detection";
import { DEFAULT_KNOWLEDGE_BASE } from "@app/core/detection/knowledge";
import { digiflazzGroupKey } from "@app/core/suppliers/digiflazz";

// Same root-.env walk-up as scripts/export-detection-fixture.ts /
// packages/core/src/config.ts — safe to run after the (hoisted) `@app/db`
// import above because Prisma Client resolves DATABASE_URL_PRISMA lazily, at
// the first actual query, not at `new PrismaClient()` construction time.
function findRootEnv(): string | undefined {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return join(dir, ".env");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
loadEnv({ path: findRootEnv() });

interface Row {
  id: number;
  name: string;
  legacyGroup: string;
  engineProductKey: string;
}

async function main(): Promise<void> {
  await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

  const products = await prisma.product.findMany({
    where: { digiflazzBrand: { not: null } },
    select: { id: true, name: true, digiflazzBrand: true },
  });

  const rows: Row[] = [];
  for (const product of products) {
    if (product.digiflazzBrand === null) continue;
    const legacyGroup = digiflazzGroupKey(product.digiflazzBrand, product.name).displayName;

    const normalizedName = normalize(product.name);
    const features = extractFeatures(normalizedName, DEFAULT_KNOWLEDGE_BASE);
    const baseProductKey = buildBaseProductKey(features.coreTokens);
    const engineProductKey = buildProductKey(baseProductKey, features.definingTokens);

    rows.push({ id: product.id, name: product.name, legacyGroup, engineProductKey });
  }

  const byEngineKey = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = byEngineKey.get(row.engineProductKey);
    if (bucket) bucket.push(row);
    else byEngineKey.set(row.engineProductKey, [row]);
  }

  const disagreements: Row[] = [];
  for (const bucket of byEngineKey.values()) {
    if (bucket.length < 2) continue;
    // Every member of this bucket has its own distinct legacyGroup (per this
    // file's doc comment), so a bucket with 2+ members IS a disagreement:
    // the engine merged products legacy has always kept separate.
    disagreements.push(...bucket);
  }

  console.log(`Scanned ${products.length} Digiflazz-imported product(s).\n`);

  if (disagreements.length === 0) {
    console.log("0 disagreements — the engine's productKey grouping never merges two products the legacy " +
      "digiflazzGroupKey-based import has always kept as separate Products.");
    await prisma.$disconnect();
    process.exit(0);
  }

  console.log(
    `${disagreements.length} product(s) across ${byEngineKey.size} engine productKey bucket(s) DISAGREE with legacy grouping:\n`,
  );
  console.log(
    `${"product id".padEnd(12)} ${"legacy group (digiflazzGroupKey)".padEnd(40)} ${"engine productKey".padEnd(30)} name`,
  );
  for (const row of disagreements) {
    console.log(
      `${String(row.id).padEnd(12)} ${row.legacyGroup.padEnd(40)} ${row.engineProductKey.padEnd(30)} ${row.name}`,
    );
  }

  console.log(
    "\nThis is Task 12's (the human-gate cutover) concern, not this script's — it only reports the table above.",
  );

  await prisma.$disconnect();
  process.exit(1);
}

main().catch(async (err) => {
  console.error("[detection-key-diff] failed:", err instanceof Error ? err.message : err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
