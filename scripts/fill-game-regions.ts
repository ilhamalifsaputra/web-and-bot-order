/**
 * Fill `Product.gameRegion` for already-imported Game Top-up products from the
 * region suffix of `Product.digiflazzBrand` (see fillGameRegions in
 * packages/db/src/crud/gameRegionBackfill.ts for the all-or-nothing rules).
 *
 *   pnpm exec tsx scripts/fill-game-regions.ts                       # dry run (default), writes nothing
 *   pnpm exec tsx scripts/fill-game-regions.ts --apply               # writes the scopes that qualify
 *   pnpm exec tsx scripts/fill-game-regions.ts --category-ids=1,2    # limit to these categories
 *
 * Refuses to run when DATABASE_URL_PRISMA points at a host other than
 * localhost / 127.0.0.1 / ::1 unless --i-know-this-is-not-local is passed.
 * Take a fresh backup before running --apply on any shared database. Exits 1
 * if a scope could not be written (a product changed mid-run, or an unexpected
 * error stopped the run) or the catalog revision bump failed.
 */
import { prisma, fillGameRegions } from "@app/db";

const USAGE = `Fill Product.gameRegion for already-imported Game Top-up products.

Usage:
  pnpm exec tsx scripts/fill-game-regions.ts [--apply] [--category-ids=1,2] [--i-know-this-is-not-local]

Options:
  --apply                     Write the scopes that qualify (default: dry run, writes nothing).
  --category-ids=1,2          Only look at these category ids.
  --i-know-this-is-not-local  Allow a database host other than localhost/127.0.0.1/::1.
  --help, -h                  Show this help.
`;

function databaseHost(): string | null {
  const url = process.env.DATABASE_URL_PRISMA;
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  let apply = false;
  let allowRemote = false;
  let categoryIds: number[] | undefined;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg === "--i-know-this-is-not-local") allowRemote = true;
    else if (arg.startsWith("--category-ids=")) {
      const parts = arg.slice("--category-ids=".length).split(",").map((s) => s.trim());
      const ids = parts.map((s) => (/^\d+$/.test(s) ? Number(s) : NaN));
      if (ids.length === 0 || ids.some(Number.isNaN)) {
        console.error(`Invalid --category-ids value: ${arg}\n`);
        console.error(USAGE);
        process.exit(2);
      }
      categoryIds = ids;
    } else {
      console.error(`Unknown option: ${arg}\n`);
      console.error(USAGE);
      process.exit(2);
    }
  }

  const host = databaseHost();
  if (!["localhost", "127.0.0.1", "::1"].includes(host ?? "") && !allowRemote) {
    console.error(
      `Refusing to run: DATABASE_URL_PRISMA points at host "${host ?? "(unset or unparsable)"}", which is not localhost, 127.0.0.1 or ::1.\n` +
        "This backfill writes product data; run it against a local copy, or pass --i-know-this-is-not-local if you really mean it.",
    );
    process.exit(2);
  }

  const report = await fillGameRegions(prisma, { apply, categoryIds });
  console.log(apply ? "Fill game regions (APPLY)\n" : "Fill game regions (dry run, nothing written)\n");
  for (const scope of report.scopes) {
    const variant = scope.gameVariant ?? "(no variant)";
    const outcome = scope.status === "failed" ? `FAILED (${scope.error})` : scope.status === "skipped" ? `SKIPPED (${scope.reason})` : scope.status === "written" ? "WRITTEN" : "WOULD WRITE";
    console.log(`- ${scope.categoryName} [#${scope.categoryId}] / ${variant}: ${outcome}`);
    for (const m of scope.members) {
      console.log(`    #${m.productId} "${m.name}" brand=${JSON.stringify(m.digiflazzBrand)} suffix=${JSON.stringify(m.suffix)} -> ${m.label ?? "(none)"}`);
    }
    if (scope.reason === "already_filled") console.log("    every product already carries the label this backfill would write; nothing to do.");
    if (scope.unknownSuffixes?.length) console.log(`    unmapped suffixes: ${scope.unknownSuffixes.join(", ")}`);
  }
  console.log(`\n${report.scopes.length} scope(s); ${report.updated} product(s) updated, ${report.skipped} product(s) in skipped scopes.`);
  if (report.scopes.some((s) => s.status === "failed")) console.log("A scope failed unexpectedly; the run stopped there and later scopes were NOT attempted.");
  if (report.revisionBumpFailed) console.log("WARNING: regions were written but bumping the detection catalog revision failed; bump it manually.");
  if (!apply) console.log("Run again with --apply to write the scopes marked WOULD WRITE.");
  console.log("\n" + JSON.stringify(report, null, 2));
  await prisma.$disconnect();
  if (report.scopes.some((s) => s.reason === "changed_concurrently" || s.status === "failed") || report.revisionBumpFailed) process.exit(1);
}

main().catch(async (e) => {
  console.error("Fill game regions failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
