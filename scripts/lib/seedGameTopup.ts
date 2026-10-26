/**
 * Guards, the one-time legacy migration, the apply orchestration and the
 * manifest-based cleanup for scripts/seed-game-topup-fixtures.ts. Kept in a
 * library file so the refusal rules and the removal are unit-testable without
 * spawning the script.
 *
 * Ownership is an invisible manifest (tests/helpers/seedManifest.ts): the ids of
 * every row the seed created or adopted. Names carry no marker.
 */
import type { PrismaClient } from "@prisma/client";
import { ensureUniqueSlug } from "@app/db";
import {
  buildGameTopupFixtures,
  FIXTURE_BUYER_FULL_NAME,
  FIXTURE_BUYER_TELEGRAM_ID,
  FIXTURE_BUYER_USERNAME,
  LEGACY_PRODUCT_RENAMES,
  type GameTopupFixtureIds,
} from "../../tests/helpers/gameTopupFixtures";
import { buildBulkGameTopupCatalog, type BulkCatalogResult } from "../../tests/helpers/gameTopupBulkCatalog";
import { SeedConflictError, SeedManifest, type SeedRowKind } from "../../tests/helpers/seedManifest";

/** The only database this seed may ever touch: the Game Top-up refactor worktree's dev database. */
export const SEED_DB_NAME = "bot_order_gtr";
/** The visible suffix the first version of the seed appended to every name; only the one-time migration still reads it. */
export const LEGACY_SEED_TAG = " [SEED-GTR]";
/** Prefix the first version of the seed put on fake supplier SKUs. */
const LEGACY_SKU_PREFIX = "fixture-";

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
  // Prisma/libpq let a query parameter override the URL host (or point at a
  // socket directory), which would bypass the localhost check above.
  for (const key of url.searchParams.keys()) {
    const k = key.toLowerCase();
    if (k === "host" || k === "hostaddr") {
      throw new Error("Refusing to run: the connection URL carries a host or hostaddr query parameter that could redirect it away from localhost.");
    }
  }
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (dbName !== SEED_DB_NAME) {
    throw new Error(`Refusing to run: the database name must be exactly "${SEED_DB_NAME}" (the Game Top-up worktree database).`);
  }
  if (!flags.confirmWorktreeDb) {
    throw new Error("Refusing to run: pass --confirm-worktree-db to confirm this is the worktree's own database.");
  }
}

export interface SeedArgs {
  help: boolean;
  confirmWorktreeDb: boolean;
  apply: boolean;
  remove: boolean;
  bulk: boolean;
  /** The first argument that is not a known flag, if any. */
  unknown: string | undefined;
}

const KNOWN_FLAGS = ["--confirm-worktree-db", "--apply", "--remove", "--bulk", "--help", "-h"];

/** Pure parsing of the seed script's command line (everything after the script name). */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    confirmWorktreeDb: argv.includes("--confirm-worktree-db"),
    apply: argv.includes("--apply"),
    remove: argv.includes("--remove"),
    bulk: argv.includes("--bulk"),
    unknown: argv.find((a) => !KNOWN_FLAGS.includes(a)),
  };
}

export type AdoptedCounts = Record<SeedRowKind, number>;

const stripTag = (value: string): string => value.slice(0, -LEGACY_SEED_TAG.length);

/**
 * One-time migration: rows the first version of the seed created carry the
 * visible suffix " [SEED-GTR]". Rename them in place (so ids and any orders that
 * reference them survive) to the clean names, fix the other visible leftovers
 * (slug, duration label, fake SKU prefix, old placeholder names, buyer profile)
 * and add them to the manifest. All or nothing: every collision with a real
 * row is checked first, and the first one stops the run with a SeedConflictError
 * before anything is written.
 */
export async function adoptLegacyTaggedRows(prisma: PrismaClient, manifest: SeedManifest): Promise<AdoptedCounts> {
  const adopted: AdoptedCounts = { categories: 0, products: 0, denominations: 0, users: 0 };
  const categories = await prisma.category.findMany({ where: { name: { endsWith: LEGACY_SEED_TAG } } });
  const products = await prisma.product.findMany({ where: { name: { endsWith: LEGACY_SEED_TAG } } });
  const denominations = await prisma.denomination.findMany({ where: { name: { endsWith: LEGACY_SEED_TAG } } });
  const users = await prisma.user.findMany({
    where: { fullName: { endsWith: LEGACY_SEED_TAG }, telegramId: BigInt(FIXTURE_BUYER_TELEGRAM_ID) },
  });

  const conflict = (kind: string, from: string, to: string, where: string) =>
    new SeedConflictError(
      `Cannot rename the ${kind} "${from}" to "${to}": ${where} already has a row with that name that is not part of this seed. Rename or remove that row, then run again.`,
    );

  const newProductName = (stripped: string) => LEGACY_PRODUCT_RENAMES[stripped]?.name ?? stripped;
  for (const c of categories) {
    const to = stripTag(c.name);
    if (await prisma.category.findFirst({ where: { name: to, id: { not: c.id } }, select: { id: true } })) {
      throw conflict("category", c.name, to, "the shop");
    }
  }
  for (const p of products) {
    const to = newProductName(stripTag(p.name));
    const clash = await prisma.product.findFirst({
      where: { categoryId: p.categoryId, name: to, gameRegion: p.gameRegion, gameVariant: p.gameVariant, id: { not: p.id } },
      select: { id: true },
    });
    if (clash) throw conflict("product", p.name, to, "the same category");
  }
  for (const d of denominations) {
    const to = stripTag(d.name);
    const clash = await prisma.denomination.findFirst({ where: { productId: d.productId, name: to, id: { not: d.id } }, select: { id: true } });
    if (clash) throw conflict("denomination", d.name, to, "the same product");
  }

  await prisma.$transaction(
    async (tx) => {
      for (const c of categories) {
        const name = stripTag(c.name);
        await tx.category.update({ where: { id: c.id }, data: { name, slug: await ensureUniqueSlug(tx, "category", name) } });
        manifest.add("categories", c.id);
        adopted.categories += 1;
      }
      for (const p of products) {
        const rename = LEGACY_PRODUCT_RENAMES[stripTag(p.name)];
        const name = rename?.name ?? stripTag(p.name);
        await tx.product.update({
          where: { id: p.id },
          data: { name, slug: await ensureUniqueSlug(tx, "product", name), ...(rename?.description ? { description: rename.description } : {}) },
        });
        manifest.add("products", p.id);
        adopted.products += 1;
      }
      for (const d of denominations) {
        const name = stripTag(d.name);
        await tx.denomination.update({
          where: { id: d.id },
          data: {
            name,
            slug: await ensureUniqueSlug(tx, "denomination", name),
            ...(d.durationLabel.endsWith(LEGACY_SEED_TAG) ? { durationLabel: stripTag(d.durationLabel) } : {}),
            ...(d.supplierSku?.startsWith(LEGACY_SKU_PREFIX) ? { supplierSku: d.supplierSku.slice(LEGACY_SKU_PREFIX.length) } : {}),
          },
        });
        manifest.add("denominations", d.id);
        adopted.denominations += 1;
      }
      for (const u of users) {
        await tx.user.update({ where: { id: u.id }, data: { fullName: FIXTURE_BUYER_FULL_NAME, username: FIXTURE_BUYER_USERNAME } });
        manifest.add("users", u.id);
        adopted.users += 1;
      }
    },
    { timeout: 120_000, maxWait: 30_000 },
  );
  return adopted;
}

export interface ApplyResult {
  adopted: AdoptedCounts;
  small: GameTopupFixtureIds;
  bulk: Omit<BulkCatalogResult, "productIds"> | undefined;
}

/**
 * Migrate any legacy-tagged rows, then create or adopt the small (and with
 * `bulk` the large) catalog. The manifest is saved even when a later step
 * refuses a same-name shop row, so the rows created so far stay removable.
 */
export async function applySeed(prisma: PrismaClient, opts: { bulk: boolean }): Promise<ApplyResult> {
  const manifest = await SeedManifest.load(prisma);
  try {
    const adopted = await adoptLegacyTaggedRows(prisma, manifest);
    const small = await buildGameTopupFixtures(prisma, { manifest });
    let bulk: ApplyResult["bulk"];
    if (opts.bulk) {
      const { productIds: _productIds, ...summary } = await buildBulkGameTopupCatalog(prisma, { manifest });
      bulk = summary;
    }
    return { adopted, small, bulk };
  } finally {
    await manifest.save(prisma);
  }
}

export interface RemovalCounts {
  denominations: number;
  products: number;
  categories: number;
  users: number;
  /** Manifest rows that could not be removed (still referenced by orders, or a category that holds other products). */
  skipped: string[];
}

/**
 * Deletes only the ids listed in the manifest, child first, then saves what is
 * left (and drops the manifest row once nothing is left). Never touches
 * settings, never drops anything. A row that other data still references is
 * skipped, reported and kept in the manifest so a later `--remove` can finish.
 */
export async function removeManifestFixtures(prisma: PrismaClient, manifest: SeedManifest): Promise<RemovalCounts> {
  const counts: RemovalCounts = { denominations: 0, products: 0, categories: 0, users: 0, skipped: [] };

  const products = await prisma.product.findMany({ where: { id: { in: [...manifest.ids.products] } }, select: { id: true, name: true } });
  for (const product of products) {
    const owned = await prisma.denomination.findMany({
      where: { productId: product.id, id: { in: [...manifest.ids.denominations] } },
      select: { id: true },
    });
    try {
      await prisma.$transaction(async (tx) => {
        const d = await tx.denomination.deleteMany({ where: { id: { in: owned.map((o) => o.id) } } });
        const left = await tx.denomination.count({ where: { productId: product.id } });
        if (left > 0) throw new Error("holds denominations that are not part of this seed");
        await tx.product.delete({ where: { id: product.id } });
        counts.denominations += d.count;
        counts.products += 1;
      });
      for (const o of owned) manifest.delete("denominations", o.id);
      manifest.delete("products", product.id);
    } catch {
      counts.skipped.push(`product "${product.name}" is still referenced or holds denominations that are not part of this seed`);
    }
  }

  const categories = await prisma.category.findMany({ where: { id: { in: [...manifest.ids.categories] } }, select: { id: true, name: true } });
  for (const category of categories) {
    if ((await prisma.product.count({ where: { categoryId: category.id } })) > 0) {
      counts.skipped.push(`category "${category.name}" still holds products`);
      continue;
    }
    try {
      await prisma.category.delete({ where: { id: category.id } });
      counts.categories += 1;
      manifest.delete("categories", category.id);
    } catch {
      counts.skipped.push(`category "${category.name}" is still referenced by other rows`);
    }
  }

  const users = await prisma.user.findMany({ where: { id: { in: [...manifest.ids.users] } }, select: { id: true } });
  for (const user of users) {
    try {
      await prisma.user.delete({ where: { id: user.id } });
      counts.users += 1;
      manifest.delete("users", user.id);
    } catch {
      counts.skipped.push("a seeded buyer is still referenced by other rows");
    }
  }

  // Ids whose rows are already gone (deleted by hand) no longer need tracking.
  const alive: Record<SeedRowKind, number[]> = {
    categories: (await prisma.category.findMany({ where: { id: { in: [...manifest.ids.categories] } }, select: { id: true } })).map((r) => r.id),
    products: (await prisma.product.findMany({ where: { id: { in: [...manifest.ids.products] } }, select: { id: true } })).map((r) => r.id),
    denominations: (await prisma.denomination.findMany({ where: { id: { in: [...manifest.ids.denominations] } }, select: { id: true } })).map((r) => r.id),
    users: (await prisma.user.findMany({ where: { id: { in: [...manifest.ids.users] } }, select: { id: true } })).map((r) => r.id),
  };
  for (const kind of Object.keys(alive) as SeedRowKind[]) {
    for (const id of [...manifest.ids[kind]]) if (!alive[kind].includes(id)) manifest.delete(kind, id);
  }
  await manifest.save(prisma);
  return counts;
}
