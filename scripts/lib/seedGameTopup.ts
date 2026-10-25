/**
 * Guards and cleanup for scripts/seed-game-topup-fixtures.ts. Kept in a library
 * file so the refusal rules and the tagged-row removal are unit-testable
 * without spawning the script.
 */
import type { PrismaClient } from "@prisma/client";

/** The only database this seed may ever touch: the Game Top-up refactor worktree's dev database. */
export const SEED_DB_NAME = "bot_order_gtr";
/** Appended to every seeded name; `--remove` deletes only rows carrying it. */
export const SEED_TAG = " [SEED-GTR]";

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "::1"];

export interface SeedFlags {
  confirmWorktreeDb: boolean;
}

/**
 * Throws when `databaseUrl` is not the worktree's local dev database or the
 * confirm flag is missing. Error messages never include the URL itself (it may
 * carry credentials); they name only the parsed host or database.
 */
export function assertSeedTarget(databaseUrl: string | undefined, flags: SeedFlags): void {
  if (!databaseUrl) throw new Error("Refusing to run: DATABASE_URL_PRISMA is not set.");
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("Refusing to run: DATABASE_URL_PRISMA is not a parsable connection URL.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(`Refusing to run: the database host "${host}" is not localhost, 127.0.0.1 or ::1.`);
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (dbName !== SEED_DB_NAME) {
    throw new Error(`Refusing to run: the database name must be exactly "${SEED_DB_NAME}" (the Game Top-up worktree database).`);
  }
  if (!flags.confirmWorktreeDb) {
    throw new Error("Refusing to run: pass --confirm-worktree-db to confirm this is the worktree's own database.");
  }
}

export interface RemovalCounts {
  denominations: number;
  products: number;
  categories: number;
  users: number;
  /** Tagged rows that could not be removed (still referenced by orders, or a category that holds untagged products). */
  skipped: string[];
}

/**
 * Deletes only rows whose name ends with `tag`, child first. Never touches
 * settings (they are shared switches, not tagged rows), never drops anything.
 * A tagged row that other data still references is skipped and reported.
 */
export async function removeTaggedFixtures(prisma: PrismaClient, tag: string): Promise<RemovalCounts> {
  const counts: RemovalCounts = { denominations: 0, products: 0, categories: 0, users: 0, skipped: [] };

  const products = await prisma.product.findMany({ where: { name: { endsWith: tag } }, select: { id: true, name: true } });
  for (const product of products) {
    try {
      await prisma.$transaction(async (tx) => {
        const d = await tx.denomination.deleteMany({ where: { productId: product.id, name: { endsWith: tag } } });
        const left = await tx.denomination.count({ where: { productId: product.id } });
        if (left > 0) throw new Error("holds untagged denominations");
        await tx.product.delete({ where: { id: product.id } });
        counts.denominations += d.count;
        counts.products += 1;
      });
    } catch {
      counts.skipped.push(`product "${product.name}" is still referenced or holds untagged denominations`);
    }
  }

  const categories = await prisma.category.findMany({ where: { name: { endsWith: tag } }, select: { id: true, name: true } });
  for (const category of categories) {
    if ((await prisma.product.count({ where: { categoryId: category.id } })) > 0) {
      counts.skipped.push(`category "${category.name}" still holds products`);
      continue;
    }
    await prisma.category.delete({ where: { id: category.id } });
    counts.categories += 1;
  }

  const users = await prisma.user.findMany({ where: { fullName: { endsWith: tag } }, select: { id: true } });
  for (const user of users) {
    try {
      await prisma.user.delete({ where: { id: user.id } });
      counts.users += 1;
    } catch {
      counts.skipped.push("a seeded buyer is still referenced by other rows");
    }
  }
  return counts;
}
