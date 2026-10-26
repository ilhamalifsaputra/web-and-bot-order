/**
 * Seed (or remove) the Game Top-up manual-test catalog in the Game Top-up
 * worktree's own database, so `@testtoko_bot` shows Game Top-up in its browse
 * menu. Rows share the builder with the E2E test (tests/helpers/gameTopupFixtures.ts)
 * and every name carries the tag " [SEED-GTR]".
 *
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db                   # dry run: counts only
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply           # create (idempotent)
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply --remove  # delete tagged rows only (bulk rows too)
 *   pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db --apply --bulk    # also the large catalog (30+ games, 600+ denominations)
 *
 * Refuses unless DATABASE_URL_PRISMA is on localhost/127.0.0.1/::1, the database
 * is exactly "bot_order_gtr", and --confirm-worktree-db is given. It never drops
 * a schema, never runs `db push`, and writes no provider credentials. It does
 * switch Game Top-up on for the bot and web and set the minimum order amount to 0
 * (shared settings; --remove leaves them as they are).
 */
import { prisma, redactConnectionUrls } from "@app/db";
import { assertSeedTarget, parseSeedArgs, removeTaggedFixtures, SEED_TAG } from "./lib/seedGameTopup";
import { buildGameTopupFixtures } from "../tests/helpers/gameTopupFixtures";
import { buildBulkGameTopupCatalog } from "../tests/helpers/gameTopupBulkCatalog";

const USAGE = `Seed the Game Top-up manual-test catalog into the worktree database.

Usage:
  pnpm exec tsx scripts/seed-game-topup-fixtures.ts --confirm-worktree-db [--apply] [--remove] [--bulk]

Options:
  --confirm-worktree-db  Required. Confirms DATABASE_URL_PRISMA is this worktree's bot_order_gtr.
  --apply                Write (default: dry run, prints counts only).
  --remove               Delete only the rows tagged "${SEED_TAG.trim()}" (without --apply: prints what would go).
  --bulk                 Also create/keep the large catalog (30+ games, regions, editions, 600+ denominations, 8 Premium apps).
                         --remove always deletes every tagged row, bulk included.
  --help, -h             Show this help.
`;

async function tagged() {
  return {
    categories: await prisma.category.count({ where: { name: { endsWith: SEED_TAG } } }),
    products: await prisma.product.count({ where: { name: { endsWith: SEED_TAG } } }),
    denominations: await prisma.denomination.count({ where: { name: { endsWith: SEED_TAG } } }),
    users: await prisma.user.count({ where: { fullName: { endsWith: SEED_TAG } } }),
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

  const before = await tagged();
  console.log(`Seed Game Top-up fixtures (${apply ? (remove ? "APPLY, remove" : "APPLY, create") : "dry run, nothing written"})`);
  console.log(`Tagged rows now: ${JSON.stringify(before)}`);
  if (!apply) {
    console.log(
      remove
        ? `Would remove the ${before.denominations} denominations, ${before.products} products, ${before.categories} categories and ${before.users} buyer tagged "${SEED_TAG.trim()}" (rows that real orders still reference are skipped). Run again with --apply --remove to delete.`
        : `Would create or keep the ${bulk ? "small and bulk " : ""}rows tagged "${SEED_TAG.trim()}". Run again with --apply${bulk ? " --bulk" : ""} to write.`,
    );
    return;
  }
  if (remove) {
    const result = await removeTaggedFixtures(prisma, SEED_TAG);
    console.log(`Removed: ${JSON.stringify({ ...result, skipped: undefined })}`);
    for (const s of result.skipped) console.log(`Skipped: ${s}`);
  } else {
    const ids = await buildGameTopupFixtures(prisma, { tag: SEED_TAG });
    console.log(`Ready: categories ${JSON.stringify(ids.categories)}, products ${JSON.stringify(ids.products)}, buyer user #${ids.userId}`);
    if (bulk) {
      const { productIds: _productIds, ...summary } = await buildBulkGameTopupCatalog(prisma, { tag: SEED_TAG });
      console.log(`Bulk catalog ready: ${JSON.stringify(summary)}`);
    }
  }
  console.log(`Tagged rows after: ${JSON.stringify(await tagged())}`);
}

main()
  .catch((e) => {
    console.error("Seed Game Top-up fixtures failed:", redactConnectionUrls(e instanceof Error ? e.message : String(e)));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
