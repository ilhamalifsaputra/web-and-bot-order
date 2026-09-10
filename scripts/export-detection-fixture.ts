/**
 * One-time-ish, read-only export of the real (or, on a fresh dev DB,
 * sample/seed) catalog into a JSON fixture the Detection Engine's
 * collision/keyStability tests (Task 11) run against, so those tests exercise
 * something closer to production shape than the synthetic Game A fixture
 * (packages/core/src/detection/__fixtures__/syntheticGameA.ts) alone.
 *
 * Reads every `Product` with a non-null `digiflazzBrand`, joined to its
 * `Denomination`s, and writes ONE row per denomination:
 *   { productName, brand, category, type, buyerSkuCode }
 *
 * Field provenance (confirmed against prisma/schema.prisma before writing
 * this):
 *   - productName  <- Product.name
 *   - brand        <- Product.digiflazzBrand
 *   - buyerSkuCode <- Denomination.supplierSku
 *   - category/type: Digiflazz's raw price-list `category`/`type` strings
 *     (DigiflazzPriceListItem, @app/core/suppliers/digiflazz) are used only
 *     transiently during import/grouping (groupDigiflazzPriceListByBrand) and
 *     are NEVER persisted onto Product or Denomination — neither model has a
 *     column for them. Always written as `null` here, not omitted, so every
 *     row has a stable shape matching CatalogEntry's `category`/`type`
 *     fields (packages/core/src/detection/types.ts).
 *
 * Deliberately excludes EVERY other field by construction: the Prisma
 * `select` clauses below name only `name`/`digiflazzBrand` (Product) and
 * `supplierSku` (Denomination) — no `price`/`costPrice`, no customer/order
 * data, no credentials. Adding a field to this export requires deliberately
 * widening those `select` clauses, not just editing the code further down.
 *
 * Read-only: issues a single `findMany`, no writes, never migrates the
 * schema. Never wired into `pretest` — run by hand:
 *
 *   pnpm export-detection-fixture
 *
 * Fails loudly on any DB error: if connecting to or querying
 * `DATABASE_URL_PRISMA` throws for any reason, this logs an error and exits
 * non-zero WITHOUT writing anything — it must never overwrite an existing
 * committed `catalogSnapshot.json` with an empty array just because this
 * particular run's connection failed transiently. A genuinely empty (but
 * reachable) catalog is a different, legitimate case: the query itself
 * succeeds and simply returns zero rows, and that zero-row result IS written
 * normally (there's nothing wrong with a worktree's dev DB having no
 * Digiflazz-imported catalog yet) — see the try/catch in `main()` for
 * exactly where that line is drawn.
 */
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma, initDb } from "@app/db";

// Load the monorepo-root `.env` regardless of cwd — same walk-up
// scripts/check-migration-drift.ts and packages/core/src/config.ts already
// use, since this script runs standalone via `tsx`, not through the Prisma
// CLI's own automatic .env load. Prisma Client resolves DATABASE_URL_PRISMA
// lazily, at the first actual query (not at `new PrismaClient()` time), so
// it's fine that this call happens after the (hoisted) `@app/db` import
// above as long as it runs before `main()`'s first query — it does, since
// this is a synchronous top-level statement and `main()` is only invoked
// at the bottom of this file.
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

export interface CatalogSnapshotRow {
  productName: string;
  brand: string;
  category: string | null;
  type: string | null;
  buyerSkuCode: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(
  HERE,
  "..",
  "packages",
  "core",
  "src",
  "detection",
  "__fixtures__",
  "catalogSnapshot.json",
);

function writeSnapshot(rows: CatalogSnapshotRow[]): void {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(rows, null, 2)}\n`, "utf-8");
}

async function main(): Promise<void> {
  let rows: CatalogSnapshotRow[] = [];

  try {
    await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

    const products = await prisma.product.findMany({
      where: { digiflazzBrand: { not: null } },
      select: {
        name: true,
        digiflazzBrand: true,
        denominations: {
          where: { supplierSku: { not: null } },
          select: { supplierSku: true },
        },
      },
    });

    for (const product of products) {
      // `where: { digiflazzBrand: { not: null } }` guarantees this, but
      // Prisma's generated type still widens digiflazzBrand to
      // `string | null` — narrow explicitly rather than a non-null
      // assertion, so a future schema change that weakens the filter can't
      // silently smuggle a null brand into the fixture.
      if (product.digiflazzBrand === null) continue;
      for (const denom of product.denominations) {
        if (denom.supplierSku === null) continue;
        rows.push({
          productName: product.name,
          brand: product.digiflazzBrand,
          category: null,
          type: null,
          buyerSkuCode: denom.supplierSku,
        });
      }
    }

    // Sort deterministically by buyerSkuCode (plain `<`/`>`, never
    // localeCompare — same determinism discipline the engine itself follows)
    // so re-running this export against an unchanged catalog produces a
    // byte-identical file, and a real diff is only ever real catalog change.
    rows.sort((a, b) => {
      if (a.buyerSkuCode < b.buyerSkuCode) return -1;
      if (a.buyerSkuCode > b.buyerSkuCode) return 1;
      return 0;
    });
  } catch (err) {
    console.error(
      "[export-detection-fixture] Failed to connect to or query the catalog via DATABASE_URL_PRISMA " +
        `(${err instanceof Error ? err.message : String(err)}). Leaving the existing committed ` +
        `${OUTPUT_PATH} untouched — re-run once the connection issue is resolved.`,
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  writeSnapshot(rows);

  const brandCount = new Set(rows.map((r) => r.brand)).size;
  console.log(
    `[export-detection-fixture] Wrote ${rows.length} row(s) across ${brandCount} brand(s) to ` +
      `${OUTPUT_PATH}`,
  );

  await prisma.$disconnect().catch(() => {});
}

main().catch(async (err) => {
  console.error("[export-detection-fixture] Unexpected failure:", err instanceof Error ? err.message : err);
  process.exit(1);
});
