/**
 * One-time migration: split already-mixed-region Digiflazz products. Fixes
 * up Products that were imported BEFORE the region-aware grouping/stripping
 * fix (groupDigiflazzPriceListByBrand / importDigiflazzBrand) shipped — a
 * single Product (e.g. "Mobile Legends") whose denominations mix several
 * regions' pricing together (Indonesia/Filipina/Russia/Brazil, ...) under one
 * brand. Every write it makes is a normal Prisma write through
 * splitMixedDigiflazzProducts, so it's safe to run against a live DB without
 * stopping services — but take a fresh backup of data/bot.db (+ -wal/-shm)
 * before running with --apply, same as any DB-mutating script.
 *
 *   pnpm split-digiflazz-regions            # dry run (default) — prints the plan, writes nothing
 *   pnpm split-digiflazz-regions --apply    # performs the split
 *
 * Dry-run reads via detectMixedDigiflazzProducts (the same read-only
 * grouping/winner-selection logic splitMixedDigiflazzProducts itself uses,
 * see packages/db/src/crud/digiflazz.ts) and only prints the plan — zero
 * writes. Idempotent: running --apply twice is safe (the second run finds
 * zero mixed products), and a second dry run prints "0 mixed products found."
 *
 * New region Products deliberately do NOT inherit the original's
 * webImageUrl/description/whatYouGet/terms/warrantyNote — that copy was
 * written for the generic mixed brand and may say something region-
 * inaccurate (e.g. IDR-specific copy on a Brazil product). Review and fill
 * those in per product after running --apply.
 */
import { prisma, initDb, detectMixedDigiflazzProducts, splitMixedDigiflazzProducts } from "@app/db";

const USAGE = `Split already-mixed-region Digiflazz products (one-time migration).

Usage:
  pnpm split-digiflazz-regions            # dry run (default) — prints the plan, writes nothing
  pnpm split-digiflazz-regions --apply    # performs the split

Options:
  --apply       Actually perform the split (default: dry run only).
  --help, -h    Show this help.

Take a fresh backup of data/bot.db (+ -wal/-shm) before running with --apply.
`;

async function main(): Promise<void> {
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

  await initDb(); // WAL + busy_timeout PRAGMAs, same as the app

  if (!apply) {
    const { mixed, skipped } = await detectMixedDigiflazzProducts(prisma);
    if (mixed.length === 0) {
      console.log("0 mixed products found.");
    } else {
      console.log(`${mixed.length} mixed product(s) found (dry run — nothing written):\n`);
      for (const plan of mixed) {
        const winner = plan.groups[0]!;
        console.log(`- "${plan.originalName}" (product id ${plan.productId})`);
        for (const group of plan.groups) {
          const isWinner = group === winner;
          const label = group.region ?? "(unspecified)";
          console.log(
            `    ${label}: ${group.denominations.length} denomination(s) -> "${group.displayName}"` +
              (isWinner ? " [keeps original id]" : " [new product]"),
          );
        }
      }
      console.log(
        `\n${mixed.length} product(s) would split into ${mixed.reduce((sum, p) => sum + p.groups.length, 0)} total products.`,
      );
      console.log(
        "Note: new region products will NOT inherit webImageUrl/description/whatYouGet/terms/warrantyNote from the original — review and fill those in after applying.",
      );
    }
    if (skipped.length > 0) {
      console.log(`\n${skipped.length} Digiflazz product(s) are already single-region and will be left untouched.`);
    }
    console.log("\nRun again with --apply to perform the split.");
    await prisma.$disconnect();
    return;
  }

  const result = await splitMixedDigiflazzProducts(prisma);
  console.log(`\nSplit ${result.productsSplit} mixed product(s), creating ${result.productsCreated} new product(s).`);
  console.log(`Moved ${result.denominationsMoved} denomination(s) to their new region product.`);
  console.log(`${result.skipped.length} product(s) were already single-region and left untouched.`);
  if (result.productsCreated > 0) {
    console.log(
      "\nNote: the newly-created region products have no webImageUrl/description/whatYouGet/terms/warrantyNote — " +
        "fill those in from the catalog admin UI.",
    );
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("Split failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
