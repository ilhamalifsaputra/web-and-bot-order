/**
 * One-time migration: split already-mixed-edition Digiflazz products. Fixes
 * up Products that were imported BEFORE the type-aware grouping fix
 * (groupDigiflazzPriceListByBrand / importDigiflazzBrand, Task 21) shipped —
 * a single Product (e.g. "Arena Breakout") whose denominations mix multiple
 * Digiflazz `type` editions together (Umum + Infinite, ...) under one brand.
 * Every write it makes is a normal Prisma write through
 * splitMixedTypeProducts, so it's safe to run against a live DB without
 * stopping services — but take a fresh backup before running with --apply,
 * same as any DB-mutating script.
 *
 * Unlike the region splitter, Digiflazz's `type` value is not persisted
 * anywhere in this DB — this script fetches the live price list ONCE, up
 * front, to build a `Map<supplierSku, normalizedTypeSuffix>` that is passed
 * into detectMixedTypeProducts/splitMixedTypeProducts as a plain parameter
 * (never fetched inside them). That fetch happens before EITHER dry-run or
 * --apply, and this script refuses to proceed (non-zero exit, no writes) if
 * credentials are missing or the fetch fails — a diagnostic run against
 * wrong/stale data is worse than refusing to run.
 *
 * ⚠ RUN ORDER MATTERS: run this migration BEFORE an admin opens the
 *   Digiflazz sync wizard again. If the wizard's type-aware grouping (Task
 *   21) imports a brand's edition group first (e.g. "Arena Breakout
 *   Infinite" as a "new" brand), it creates a SECOND product holding SKUs
 *   already present on the old mixed product. This migration's collision
 *   guard then correctly refuses to touch the mixed product (reports it
 *   under `conflicts`), leaving it stuck until a human resolves the
 *   duplicate manually. Run this BEFORE the wizard is used again on this
 *   code, every time, on a freshly-deployed environment.
 *
 *   pnpm split-digiflazz-types            # dry run (default) — prints the plan, writes nothing
 *   pnpm split-digiflazz-types --apply    # performs the split
 *
 * Dry-run reads via detectMixedTypeProducts (the same read-only
 * grouping/winner-selection logic splitMixedTypeProducts itself uses, see
 * packages/db/src/crud/digiflazz.ts) and only prints the plan — zero writes.
 * Idempotent: running --apply twice is safe (the second run finds zero mixed
 * products), and a second dry run prints "0 mixed products found."
 *
 * New edition Products deliberately do NOT inherit the original's
 * webImageUrl/description/whatYouGet/terms/warrantyNote — that copy was
 * written for the generic mixed brand and may not describe the split-out
 * edition accurately. Review and fill those in per product after running
 * --apply.
 */
import {
  prisma,
  initDb,
  getDigiflazzCreds,
  detectMixedTypeProducts,
  splitMixedTypeProducts,
  countCategoryProductsWithoutGameVariant,
  getCategory,
  digiflazzTypeSuffix,
  collapseToCheapestSeller,
} from "@app/db";
import { getPriceList } from "@app/core/suppliers/digiflazz";

const USAGE = `Split already-mixed-edition Digiflazz products (one-time migration).

Usage:
  pnpm split-digiflazz-types            # dry run (default) — prints the plan, writes nothing
  pnpm split-digiflazz-types --apply    # performs the split

Options:
  --apply       Actually perform the split (default: dry run only).
  --help, -h    Show this help.

Take a fresh backup before running with --apply.

Run this BEFORE using the Digiflazz sync wizard on this code — importing an
edition group first creates duplicate SKUs and blocks the split for that
product until a human resolves the collision.
`;

/** Print the Category-scope warning (once per distinct categoryId among
 * `mixed` plans) when setting gameVariant here would leave a category
 * "mixed" (some products labelled, some not) — see
 * countCategoryProductsWithoutGameVariant's own doc comment for why that
 * matters to the bot's variant picker. */
async function printCategoryScopeWarnings(
  mixed: Awaited<ReturnType<typeof detectMixedTypeProducts>>["mixed"],
): Promise<void> {
  const categoryIds = [...new Set(mixed.map((plan) => plan.categoryId))];
  for (const categoryId of categoryIds) {
    const count = await countCategoryProductsWithoutGameVariant(prisma, categoryId);
    if (count > 0) {
      const category = await getCategory(prisma, categoryId);
      console.log(
        `\n!! Category "${category?.name ?? categoryId}" has ${count} other product(s) with no gameVariant set. Setting\n` +
          "   gameVariant here does NOT show the bot's variant picker for that category\n" +
          "   (every catalog-eligible product in a category must be labelled first —\n" +
          "   see countCategoryProductsWithoutGameVariant), and if that guard is ever\n" +
          "   removed those other products would be hidden from bot navigation. Give\n" +
          "   this game its own Category with group=GAME_TOPUP to enable the picker.",
      );
    }
  }
}

function printUnmapped(unmapped: Awaited<ReturnType<typeof detectMixedTypeProducts>>["unmapped"]): void {
  if (unmapped.length === 0) return;
  console.log(
    `\n!! ${unmapped.length} product(s) have a denomination Digiflazz-import can't map to a \`type\`\n` +
      "   value (a manually-added SKU, or one Digiflazz has retired) and were\n" +
      "   EXCLUDED ENTIRELY from this run:",
  );
  for (const entry of unmapped) {
    console.log(`    ! "${entry.productName}" (product id ${entry.productId}): ${entry.denominationNames.join(", ")}`);
  }
}

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

  // Fetch the live price list ONCE, before dry-run OR apply — see this
  // file's module doc comment. Fail hard on missing credentials or a fetch
  // error; never proceed with a partial/empty map in either mode.
  const creds = await getDigiflazzCreds(prisma);
  if (!creds) {
    console.error("Digiflazz credentials are not configured. Set them in Settings first.");
    process.exit(1);
  }
  let priceList;
  try {
    priceList = await getPriceList(creds);
  } catch (err) {
    console.error(`Failed to fetch the Digiflazz price list: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  // Collapse to one row per SKU first — same as groupDigiflazzPriceListByBrand
  // — so two sellers disagreeing on a SKU's type can't make this map's
  // winner depend on array order instead of the same cheapest-seller
  // selection the rest of the import path already treats as authoritative.
  const typeMap = new Map<string, string | null>(
    collapseToCheapestSeller(priceList).map((item) => [item.buyerSkuCode, digiflazzTypeSuffix(item.type)]),
  );

  if (!apply) {
    const { mixed, skipped, conflicts, unmapped } = await detectMixedTypeProducts(prisma, typeMap);
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
          const label = group.suffix ?? "Umum";
          console.log(
            `    ${label}: ${group.denominations.length} denomination(s) -> "${group.displayName}"` +
              (isWinner ? " [keeps original id]" : " [new product]"),
          );
          // Print the actual denomination names (capped at 5) so an operator
          // can visually confirm a bucket really is a distinct edition
          // variant of the product, not a false-positive split.
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
        "Note: new edition products will NOT inherit webImageUrl/description/whatYouGet/terms/warrantyNote from the original — review and fill those in after applying.",
      );
      await printCategoryScopeWarnings(mixed);
    }
    if (skipped.length > 0) {
      console.log(`\n${skipped.length} Digiflazz product(s) are already single-edition and will be left untouched.`);
    }
    printUnmapped(unmapped);
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
    if (conflicts.length > 0) {
      process.exit(1);
    }
    return;
  }

  const result = await splitMixedTypeProducts(prisma, typeMap);
  console.log(`\nSplit ${result.productsSplit} mixed product(s), creating ${result.productsCreated} new product(s).`);
  console.log(`Moved ${result.denominationsMoved} denomination(s) to their new edition product.`);
  console.log(`${result.skipped.length} product(s) were already single-edition and left untouched.`);
  if (result.productsCreated > 0) {
    console.log(
      "\nNote: the newly-created edition products have no webImageUrl/description/whatYouGet/terms/warrantyNote — " +
        "fill those in from the catalog admin UI.",
    );
  }
  printUnmapped(result.unmapped);
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
  // Same reasoning as split-digiflazz-regions.ts: unresolved conflicts are
  // also an incomplete migration, not just failures — exit non-zero for
  // both so a deploy script or CI wrapper checking the exit status can
  // detect it instead of silently seeing exit 0.
  if (result.failures.length > 0 || result.conflicts.length > 0) {
    process.exit(1);
  }
}

main().catch(async (e) => {
  console.error("Split failed:", e instanceof Error ? e.message : e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
