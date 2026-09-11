/**
 * Standalone dev-only seed for the Fase 12 thumbnail/currency-icon visual
 * QA pass (Task 20's 32-route Playwright audit, run by hand against a
 * manually-started dev server — NOT chained into playwright.config.ts and
 * NOT part of the checkout suite's fixtures).
 *
 * Populates a dedicated Postgres schema with catalog data that exercises
 * every resolution path in apps/storefront/src/images.ts's
 * `defaultThumbKind` and apps/storefront/src/denomIcon.ts's
 * `resolveDenomIconKind`:
 *   1. Real photo (Product.webImageUrl set)            -> real <img>/<picture>.
 *   2. No photo, admin thumbnailKind/currencyIconKind   -> override wins,
 *      set to something that DIFFERS from what the heuristic would pick.
 *   3. No photo, no override                            -> automatic
 *      category/qtyUnit heuristic.
 *   4. PREMIUM_APPS category, with and without an
 *      explicit override                                -> both forced to
 *      "generic"/no-chip regardless (Fase 12's unconditional rule).
 *
 * Isolation approach — same techniques as tests/e2e/seed.ts (read that file
 * first), pointed at a DIFFERENT fixed schema so the two scripts can never
 * collide with each other or with the checkout suite's own E2E_SCHEMA:
 *  - One fixed schema name (SCHEMA below), dropped + recreated at the top of
 *    every run via `prisma db push`, same as seed.ts.
 *  - Same crud helpers (createCategory / createCatalogProduct /
 *    createDenomination / bulkAddStock) from `@app/db`.
 *  - `markSetupComplete(db)` so a live dev server pointed at this schema
 *    doesn't 503 on every request behind the first-run setup gate.
 *
 * Unlike seed.ts, this script also copies a couple of real image files into
 * the gitignored `data/uploads/products/` directory (see "Seed images"
 * below) and runs them through the same WebP-derivative pipeline the admin
 * upload path uses, so the photo-backed products exercise the real
 * `<picture>`/webpSrcset() code path, not just a bare `<img src>`.
 *
 * Run with (PowerShell):
 *   $env:DATABASE_URL_PRISMA = "postgresql://bot_order:main-checkout-local-dev-9c4e7a2f@localhost:5432/bot_order?schema=e2e_thumbs_seed"
 *   pnpm exec tsx tests/e2e/seed-thumbs.ts
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  createCategory,
  createCatalogProduct,
  createDenomination,
  bulkAddStock,
  markSetupComplete,
} from "@app/db";
import { ProductType, CategoryGroup } from "@app/core/enums";
// Reused directly from web-admin's own upload pipeline (same function
// scripts/backfill-webp.ts calls) rather than reimplemented here — Node
// resolves `sharp`/`@app/core` from THIS file's own location when it's
// loaded, so importing it by relative path from outside apps/web-admin
// still finds apps/web-admin's node_modules correctly.
import { generateWebpVariants, PRODUCT_WIDTHS } from "../../apps/web-admin/src/lib/webpVariants";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

/**
 * Dedicated schema for this seed — distinct from tests/e2e/schema.ts's
 * E2E_SCHEMA (the checkout suite's fixed schema) so the two scripts can
 * never step on each other, even if both happen to be run against the same
 * shared dev Postgres instance at once.
 */
const SCHEMA = "e2e_thumbs_seed";

const PRODUCTS_DIR = join(ROOT, "data", "uploads", "products");

/** Files copied from gogogo-frontend/assets/icons/ as stand-in product art —
 * see the IMPORTANT correction in the Task 18 brief: there is no
 * gogogo-frontend/assets/catalog/ folder, only assets/icons/<game>/*, which
 * is small denomination-icon art, not full product photography. That's fine
 * here — the seed only needs SOME real image bytes with real dimensions to
 * exercise the <picture>/object-cover crop rendering visually. */
const ML_IMAGE = {
  source: join(ROOT, "gogogo-frontend", "assets", "icons", "mobile-legends", "weekly-diamond-pass.webp"),
  destName: "devseed-mobile-legends-diamonds.webp",
};
const FF_IMAGE = {
  source: join(ROOT, "gogogo-frontend", "assets", "icons", "free-fire", "diamonds.png"),
  destName: "devseed-free-fire-diamonds.png",
};
const SEED_IMAGES: Array<{ source: string; destName: string }> = [ML_IMAGE, FF_IMAGE];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL_PRISMA;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL_PRISMA must be set (schema-scoped) before running the thumbnail seed.");
  }
  const schema = new URL(databaseUrl).searchParams.get("schema");
  if (schema !== SCHEMA) {
    // Guards against ever accidentally seeding into the shared `public`
    // schema (or someone else's) if this script is ever invoked directly
    // with the wrong env — the drop-and-recreate below is destructive.
    throw new Error(
      `Refusing to seed: DATABASE_URL_PRISMA's ?schema= is "${schema ?? "(none)"}", expected "${SCHEMA}". ` +
        "This script only ever seeds its own dedicated schema — see the SCHEMA constant in tests/e2e/seed-thumbs.ts.",
    );
  }

  // 1. Fresh schema. DROP...CASCADE is a no-op if it doesn't exist yet (first
  //    run) and wipes any leftovers from an interrupted prior run otherwise —
  //    every run starts from a clean slate.
  const dropClient = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await dropClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await dropClient.$disconnect();
  }

  // `prisma db push` issues the CREATE SCHEMA + every CREATE TABLE in
  // FK-correct order — same mechanism tests/helpers/testdb.ts relies on.
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL_PRISMA: databaseUrl },
    stdio: "inherit",
  });

  // 2. Copy stand-in product images into the gitignored uploads dir, then
  //    generate their WebP derivatives so webpSrcset() has something to
  //    find (see apps/storefront/src/images.ts). This never touches git —
  //    `data/` is already gitignored (repo root .gitignore line 13).
  mkdirSync(PRODUCTS_DIR, { recursive: true });
  for (const { source, destName } of SEED_IMAGES) {
    if (!existsSync(source)) {
      throw new Error(`Seed image source missing: ${source}`);
    }
    copyFileSync(source, join(PRODUCTS_DIR, destName));
    await generateWebpVariants(PRODUCTS_DIR, destName, PRODUCT_WIDTHS);
  }

  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    // Skip the first-run setup wizard gate (packages/db/src/crud/setup.ts) —
    // a brand-new schema with no admin password set makes every storefront
    // request 503 ("shop not active yet") until this is done.
    await markSetupComplete(db);

    // ---- Categories ----
    const gameTopupCategory = await createCategory(db, {
      name: "Seed Game Topup",
      emoji: "\u{1F3AE}",
      group: CategoryGroup.GAME_TOPUP,
    });
    const premiumAppsCategory = await createCategory(db, {
      name: "Seed Premium Apps",
      emoji: "✨",
      group: CategoryGroup.PREMIUM_APPS,
    });
    // group: null on purpose — exercises the CATEGORY_NAME_KINDS substring
    // heuristic in apps/storefront/src/images.ts (defaultThumbKind), not the
    // group-based branches.
    const voucherCategory = await createCategory(db, {
      name: "Seed Voucher Deals",
      emoji: "\u{1F3AB}",
      group: null,
    });
    const steamCategory = await createCategory(db, {
      name: "Seed Steam Wallet",
      emoji: "\u{1F3AE}",
      group: null,
    });

    type SeededProduct = { id: number; name: string; path: string };
    const seeded: SeededProduct[] = [];

    // ---- 1. Real photo (webImageUrl set) — photo always wins, no override needed ----
    const mlPhotoProduct = await createCatalogProduct(db, {
      categoryId: gameTopupCategory.id,
      name: "Mobile Legends Diamonds (Photo)",
      description: "Devseed: real photo path — webImageUrl set, no thumbnailKind/currencyIconKind override.",
      webImageUrl: `/uploads/products/${ML_IMAGE.destName}`,
    });
    const mlDenom = await createDenomination(db, {
      productId: mlPhotoProduct.id,
      name: "170 Diamonds",
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: "15000",
      warrantyDays: 30,
      qtyValue: 170,
      qtyUnit: "Diamonds",
    });
    await bulkAddStock(db, mlDenom.id, ["ml-diamonds-cred-1", "ml-diamonds-cred-2", "ml-diamonds-cred-3"]);
    seeded.push({ id: mlPhotoProduct.id, name: mlPhotoProduct.name, path: "1. real photo" });

    const ffPhotoProduct = await createCatalogProduct(db, {
      categoryId: gameTopupCategory.id,
      name: "Free Fire Diamonds (Photo)",
      description: "Devseed: real photo path — webImageUrl set, no thumbnailKind/currencyIconKind override.",
      webImageUrl: `/uploads/products/${FF_IMAGE.destName}`,
    });
    const ffDenom = await createDenomination(db, {
      productId: ffPhotoProduct.id,
      name: "70 Diamonds",
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: "12000",
      warrantyDays: 30,
      qtyValue: 70,
      qtyUnit: "Diamonds",
    });
    await bulkAddStock(db, ffDenom.id, ["ff-diamonds-cred-1", "ff-diamonds-cred-2", "ff-diamonds-cred-3"]);
    seeded.push({ id: ffPhotoProduct.id, name: ffPhotoProduct.name, path: "1. real photo" });

    // ---- 3. No photo, no override — automatic heuristic ----
    const gameHeuristicProduct = await createCatalogProduct(db, {
      categoryId: gameTopupCategory.id,
      name: "Free Fire Top Up (Auto Heuristic)",
      description: "Devseed: heuristic path — no webImageUrl, no override; category.group=GAME_TOPUP -> 'game' thumbnail, qtyUnit 'Diamonds' -> 'diamond' currency icon.",
    });
    const gameHeuristicDenom = await createDenomination(db, {
      productId: gameHeuristicProduct.id,
      name: "355 Diamonds",
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: "50000",
      warrantyDays: 30,
      qtyValue: 355,
      qtyUnit: "Diamonds",
    });
    await bulkAddStock(db, gameHeuristicDenom.id, ["ff-auto-cred-1", "ff-auto-cred-2", "ff-auto-cred-3"]);
    seeded.push({ id: gameHeuristicProduct.id, name: gameHeuristicProduct.name, path: "3. auto heuristic (game/diamond)" });

    const steamHeuristicProduct = await createCatalogProduct(db, {
      categoryId: steamCategory.id,
      name: "Steam Wallet Code 60000",
      description: "Devseed: heuristic path — no webImageUrl, no override; category name contains 'steam' -> 'steam' thumbnail, no qtyUnit match -> no currency chip.",
    });
    const steamHeuristicDenom = await createDenomination(db, {
      productId: steamHeuristicProduct.id,
      name: "IDR 60.000",
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: "65000",
      warrantyDays: 30,
    });
    await bulkAddStock(db, steamHeuristicDenom.id, ["steam-code-cred-1", "steam-code-cred-2", "steam-code-cred-3"]);
    seeded.push({ id: steamHeuristicProduct.id, name: steamHeuristicProduct.name, path: "3. auto heuristic (steam/none)" });

    const voucherHeuristicProduct = await createCatalogProduct(db, {
      categoryId: voucherCategory.id,
      name: "Voucher Belanja 100K",
      description: "Devseed: heuristic path — no webImageUrl, no override; category name contains 'voucher' -> 'voucher' thumbnail, no qtyUnit match -> no currency chip.",
    });
    const voucherHeuristicDenom = await createDenomination(db, {
      productId: voucherHeuristicProduct.id,
      name: "Rp100.000",
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: "98000",
      warrantyDays: 30,
    });
    await bulkAddStock(db, voucherHeuristicDenom.id, ["voucher-cred-1", "voucher-cred-2", "voucher-cred-3"]);
    seeded.push({ id: voucherHeuristicProduct.id, name: voucherHeuristicProduct.name, path: "3. auto heuristic (voucher/none)" });

    // ---- 2. No photo, explicit override that DIFFERS from the heuristic ----
    const overrideProduct = await createCatalogProduct(db, {
      categoryId: gameTopupCategory.id,
      name: "Special Bundle (Admin Override)",
      description: "Devseed: admin-override path — category.group=GAME_TOPUP would heuristically say 'game'/'diamond', but thumbnailKind/currencyIconKind are explicitly set to something different.",
      thumbnailKind: "voucher",
      currencyIconKind: "coin",
    });
    const overrideDenom = await createDenomination(db, {
      productId: overrideProduct.id,
      name: "Bundle Pack",
      type: ProductType.SHARED,
      durationLabel: "1x",
      price: "25000",
      warrantyDays: 30,
      qtyUnit: "Gems",
    });
    await bulkAddStock(db, overrideDenom.id, ["bundle-cred-1", "bundle-cred-2", "bundle-cred-3"]);
    seeded.push({ id: overrideProduct.id, name: overrideProduct.name, path: "2. admin override (voucher/coin, differs from heuristic)" });

    // ---- 4. PREMIUM_APPS — forced generic/no-chip, with and without an override ----
    const premiumNoOverrideProduct = await createCatalogProduct(db, {
      categoryId: premiumAppsCategory.id,
      name: "Netflix Premium (No Override)",
      description: "Devseed: PREMIUM_APPS path, no override — thumbnail forced 'generic', currency chip forced off.",
    });
    const premiumNoOverrideDenom = await createDenomination(db, {
      productId: premiumNoOverrideProduct.id,
      name: "1 Bulan",
      type: ProductType.SHARED,
      durationLabel: "1 Bulan",
      price: "55000",
      warrantyDays: 30,
    });
    await bulkAddStock(db, premiumNoOverrideDenom.id, ["netflix-cred-1", "netflix-cred-2", "netflix-cred-3"]);
    seeded.push({ id: premiumNoOverrideProduct.id, name: premiumNoOverrideProduct.name, path: "4. PREMIUM_APPS, no override (forced generic/none)" });

    const premiumOverrideIgnoredProduct = await createCatalogProduct(db, {
      categoryId: premiumAppsCategory.id,
      name: "Spotify Premium (Override Ignored)",
      description: "Devseed: PREMIUM_APPS path, WITH an override set — thumbnailKind='entertainment'/currencyIconKind='diamond' are both explicitly set but must be ignored: PREMIUM_APPS forces 'generic'/no-chip unconditionally.",
      thumbnailKind: "entertainment",
      currencyIconKind: "diamond",
    });
    const premiumOverrideIgnoredDenom = await createDenomination(db, {
      productId: premiumOverrideIgnoredProduct.id,
      name: "1 Bulan",
      type: ProductType.SHARED,
      durationLabel: "1 Bulan",
      price: "45000",
      warrantyDays: 30,
    });
    await bulkAddStock(db, premiumOverrideIgnoredDenom.id, ["spotify-cred-1", "spotify-cred-2", "spotify-cred-3"]);
    seeded.push({
      id: premiumOverrideIgnoredProduct.id,
      name: premiumOverrideIgnoredProduct.name,
      path: "4. PREMIUM_APPS, override set but ignored (still forced generic/none)",
    });

    console.log(
      `[thumbs seed] ready — schema "${schema}"\n` +
        `  categories: Seed Game Topup #${gameTopupCategory.id}, Seed Premium Apps #${premiumAppsCategory.id}, ` +
        `Seed Voucher Deals #${voucherCategory.id}, Seed Steam Wallet #${steamCategory.id}\n` +
        seeded.map((p) => `  product #${p.id} "${p.name}" — ${p.path}`).join("\n"),
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[thumbs seed] failed:", err);
  process.exit(1);
});
