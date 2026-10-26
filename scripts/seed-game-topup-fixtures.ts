/**
 * Seed (or remove) the Game Top-up manual-test catalog in the Game Top-up
 * worktree's own database, so `@testtoko_bot` shows Game Top-up in its browse
 * menu. Rows share the builder with the E2E test (tests/helpers/gameTopupFixtures.ts).
 * Names look like a real shop's: nothing visible marks them as seed data.
 * Ownership is an invisible manifest instead: the ids of every row this script
 * created or adopted are stored as JSON in one settings row,
 * `seed_game_topup_manifest`, in the target database only (no secrets).
 *
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db                   # dry run: counts only
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply           # create (idempotent)
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply --remove  # delete the manifest's rows only (bulk rows too)
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply --bulk    # the large per-game catalog INSTEAD of the small one
 *
 * Without --bulk the small fixture is built ("Game Top Up" with a few games and
 * "Mixed Games"). With --bulk the large catalog is built instead: one Game Top-up
 * category per game (about 32 games, mobile first then PC), the region and edition
 * pickers live inside each game, plus 8 Premium Apps and the buyer. The two
 * never coexist (a mixed "Game Top Up" category would sit next to the per-game
 * ones); --bulk removes the manifest's rows of the older layout first (stopping
 * with a message, changing nothing, when an order references one).
 *
 * Refuses unless DATABASE_URL_PRISMA is on localhost/127.0.0.1/::1, the database
 * is exactly "bot_order_gtr", and --confirm-worktree-db is given. It never drops
 * a schema, never runs `db push`, and writes no provider credentials. It refuses
 * to adopt a category/product/denomination/buyer that already exists under a seed
 * name but is not in the manifest (a shop's real row). --apply also renames, in
 * place, rows left by the first version of this seed that still end in the old
 * visible suffix, and adds them to the manifest. It does switch Game Top-up on
 * for the bot and web and set the minimum order amount to 0 (shared settings;
 * --remove leaves them as they are).
 */
import { prisma, redactConnectionUrls } from "@app/db";
import { assertSeedTarget, parseSeedArgs, applySeed, removeManifestFixtures, LEGACY_SEED_TAG } from "./lib/seedGameTopup";
import { SeedConflictError, SeedManifest, SEED_MANIFEST_KEY } from "../tests/helpers/seedManifest";

const USAGE = `Seed the Game Top-up manual-test catalog into the worktree database.

Usage:
  pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db [--apply] [--remove] [--bulk]

Options:
  --confirm-worktree-db  Required. Confirms DATABASE_URL_PRISMA is this worktree's bot_order_gtr.
  --apply                Write (default: dry run, prints counts only).
  --remove               Delete only the rows listed in the "${SEED_MANIFEST_KEY}" settings row
                         (without --apply: prints what would go). Real shop rows are never touched.
  --bulk                 Build the large per-game catalog (one category per game with its region/edition pickers, 600+
                         denominations, 8 Premium apps) instead of the small fixture. An older bulk layout in the manifest
                         is replaced first. --remove always deletes every manifest row.
  --help, -h             Show this help.
`;

async function legacyTagged() {
  return {
    categories: await prisma.category.count({ where: { name: { endsWith: LEGACY_SEED_TAG } } }),
    products: await prisma.product.count({ where: { name: { endsWith: LEGACY_SEED_TAG } } }),
    denominations: await prisma.denomination.count({ where: { name: { endsWith: LEGACY_SEED_TAG } } }),
    users: await prisma.user.count({ where: { fullName: { endsWith: LEGACY_SEED_TAG } } }),
  };
}

async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.unknown) {
    console.error(`Unknown option: ${args.unknown}\n\n${USAGE}`);
    process.exit(2);
  }
  const { apply, remove, bulk } = args;
  try {
    assertSeedTarget(process.env.DATABASE_URL_PRISMA, { confirmWorktreeDb: args.confirmWorktreeDb });
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  const manifest = await SeedManifest.load(prisma);
  const legacy = await legacyTagged();
  console.log(`Seed Game Top-up fixtures (${apply ? (remove ? "APPLY, remove" : "APPLY, create") : "dry run, nothing written"})`);
  console.log(`Rows in the manifest now: ${JSON.stringify(manifest.counts())}`);
  const hasLegacy = Object.values(legacy).some((n) => n > 0);
  if (hasLegacy) console.log(`Rows from the first seed version still ending in "${LEGACY_SEED_TAG.trim()}": ${JSON.stringify(legacy)}`);
  if (!apply) {
    const c = manifest.counts();
    console.log(
      remove
        ? `Would remove the ${c.denominations} denominations, ${c.products} products, ${c.categories} categories and ${c.users} buyer listed in the manifest (rows that real orders still reference are skipped). Run again with --apply --remove to delete.`
        : `Would create or keep the ${bulk ? "large per-game catalog (replacing the manifest's older layout when there is one; no small fixture)" : "small fixture"} rows${hasLegacy ? ` and rename the ${legacy.categories + legacy.products + legacy.denominations + legacy.users} old-suffix rows in place` : ""}. Run again with --apply${bulk ? " --bulk" : ""} to write.`,
    );
    return;
  }
  if (remove) {
    const result = await removeManifestFixtures(prisma, manifest);
    console.log(`Removed: ${JSON.stringify({ ...result, skipped: undefined })}`);
    for (const s of result.skipped) console.log(`Skipped: ${s}`);
  } else {
    try {
      const { adopted, migrated, small, bulk: bulkSummary, userId } = await applySeed(prisma, { bulk });
      if (Object.values(adopted).some((n) => n > 0)) console.log(`Renamed in place (old suffix removed): ${JSON.stringify(adopted)}`);
      if (Object.values(migrated).some((n) => n > 0)) console.log(`Replaced the older catalog layout, removed: ${JSON.stringify(migrated)}`);
      if (small) console.log(`Ready: categories ${JSON.stringify(small.categories)}, products ${JSON.stringify(small.products)}, buyer user #${small.userId}`);
      if (bulkSummary) {
        const { categories, ...counts } = bulkSummary;
        console.log(`Per-game catalog ready: ${JSON.stringify({ ...counts, premiumAppsCategoryId: categories.premiumApps })}, buyer user #${userId}`);
      }
    } catch (e) {
      if (e instanceof SeedConflictError) {
        console.error(`Stopped: ${e.message}`);
        process.exitCode = 1;
      } else {
        throw e;
      }
    }
  }
  console.log(`Rows in the manifest after: ${JSON.stringify((await SeedManifest.load(prisma)).counts())}`);
}

main()
  .catch((e) => {
    console.error("Seed Game Top-up fixtures failed:", redactConnectionUrls(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
