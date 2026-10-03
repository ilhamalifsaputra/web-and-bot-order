/**
 * One-time migration: split already-mixed-region Digiflazz products. Fixes
 * up Products that were imported BEFORE the region-aware grouping/stripping
 * fix (groupDigiflazzPriceListByBrand / importDigiflazzBrand) shipped — a
 * single Product (e.g. "Mobile Legends") whose denominations mix several
 * regions' pricing together (Indonesia/Filipina/Russia/Brazil, ...) under one
 * brand. Every write it makes is a normal Prisma write through
 * splitMixedDigiflazzProducts, so it's safe to run against a live DB without
 * stopping services — but take a fresh database backup (pg_dump)
 * before running with --apply, same as any DB-mutating script.
 *
 * ⚠ RUN ORDER MATTERS (Finding 2, final whole-branch review): run this script
 *   (and resolve any reported `conflicts`) BEFORE an admin opens the
 *   Digiflazz sync wizard on this new code. After deploy but before this
 *   migration runs, an old mixed Product (e.g. "Mobile Legends") still holds
 *   its OLD digiflazzBrand. If the wizard's new region-aware grouping is used
 *   first and imports one of that brand's region groups (e.g. "Mobile
 *   Legends (Indonesia)"), it creates a SECOND product with duplicate
 *   supplierSku values already present on the old mixed product. This
 *   migration's collision guard then correctly refuses to touch that mixed
 *   product (reports it under `conflicts`, writes nothing to it) — but it's
 *   then stuck unsplit until a human manually resolves the duplicate. Run
 *   this migration first, every time, on a freshly-deployed environment.
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

Take a fresh database backup (pg_dump) before running with --apply.

Run this BEFORE using the Digiflazz sync wizard on this code — importing a
region group first creates duplicate SKUs and blocks the split for that
product until a human resolves the collision.
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

  await initDb(); // no-op on Postgres; kept for boot-sequencing parity with the app

  if (!apply) {
    const { mixed, skipped, conflicts } = await detectMixedDigiflazzProducts(prisma);
    if (mixed.length === 0 && conflicts.length === 0) {
      console.log("0 mixed products found.");
    } else if (mixed.length === 0) {
      console.log("0 splittable mixed products found.");
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
          // Print the actual denomination names (capped at 5) so an operator
          // can visually confirm a bucket really is a distinct region variant
          // of the product, not a false-positive split caused by
          // parseProductRegion mis-parsing a legitimate trailing parenthetical
          // (e.g. "Weekly Diamond Pass (Promo)") as a region — a 1-row bucket
          // otherwise looks identical whether it's a genuine small region or a
          // mis-parse, and there'd be nothing here to catch the difference.
          const shown = group.denominations.slice(0, 5);
          const more = group.denominations.length - shown.length;
          for (const denom of shown) {
            console.log(`        - ${denom.name}`);
          }
          if (more > 0) {
            console.log(`        ... (+${more} more)`);
          }
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
    if (conflicts.length > 0) {
      console.log(
        `\n!! ${conflicts.length} mixed product(s) CANNOT be split due to a digiflazzBrand conflict with an existing product — will be left completely untouched:\n`,
      );
      for (const conflict of conflicts) {
        console.log(`    ! ${conflict}`);
      }
      console.log("\n  Resolve these manually (e.g. delete/merge the stray duplicate) before re-running --apply.");
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
  if (result.conflicts.length > 0) {
    console.log(
      `\n!! ${result.conflicts.length} mixed product(s) were SKIPPED (left completely untouched) due to a digiflazzBrand conflict with an existing product:\n`,
    );
    for (const conflict of result.conflicts) {
      console.log(`    ! ${conflict}`);
    }
    console.log("\n  Resolve these manually (e.g. delete/merge the stray duplicate) and re-run --apply.");
  }
  if (result.failures.length > 0) {
    console.log(
      `\n!! ${result.failures.length} product(s) FAILED to split due to an unexpected error — left untouched (each product's transaction rolled back on its own error, so products split successfully before the failure are unaffected):\n`,
    );
    for (const failure of result.failures) {
      console.log(`    ! "${failure.productName}": ${failure.error}`);
    }
    console.log("\n  Investigate the error and re-run --apply — the migration is idempotent, so already-split products are skipped and only these will be retried.");
  }

  await prisma.$disconnect();
  // Finding 4 (final whole-branch review): unresolved conflicts are also an
  // incomplete migration, not just failures — exit non-zero for both so a
  // deploy script or CI wrapper checking the exit status can detect it
  // instead of silently seeing exit 0.
  if (result.failures.length > 0 || result.conflicts.length > 0) {
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("Split failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
