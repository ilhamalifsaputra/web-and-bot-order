/**
 * Shared Game Top-up fixture builder (Phase 5). One shape, two callers: the
 * order-bot E2E test and the manual seed script (scripts/seed-game-topup-fixtures.ts),
 * so what a developer taps through in `@testtoko_bot` is what the tests assert.
 *
 * Built with the repo's real crud helpers (the same ones tests/e2e/seed.ts and
 * apps/order-bot/test/game-account-input.test.ts use), never raw inserts.
 *
 * Idempotency: names are realistic and carry no marker. Each row is found by its
 * deterministic (category, product, denomination) name before it is created, so
 * running the builder twice yields the same ids and no duplicates. Pass
 * `opts.manifest` (tests/helpers/seedManifest.ts) when seeding a database that
 * may hold a shop's own rows: created ids are recorded in it, a row already in
 * it is adopted, and a same-name row that is NOT in it is refused with a
 * SeedConflictError instead of being taken over. Without a manifest (the E2E
 * test's empty database) any same-name row is reused.
 *
 * No provider credentials are written: the Digiflazz denomination carries a
 * fake `supplierSku` only. Do not import this from product code.
 */
import type { PrismaClient } from "@prisma/client";
import {
  createCategory,
  createCatalogProduct,
  createDenomination,
  setSetting,
  upsertUser,
  MIN_ORDER_AMOUNT_IDR_KEY,
} from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { CUSTOMER_SERVICES } from "@app/core/services";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { Decimal } from "@app/core/money";
import { guardExisting, type SeedManifest } from "./seedManifest";

/** A fake Telegram id that is not in ADMIN_IDS (the buyer for E2E and manual taps). */
export const FIXTURE_BUYER_TELEGRAM_ID = 7_770_000_001;

export interface GameTopupFixtureIds {
  categories: { gameTopup: number; mixed: number; premiumApps: number };
  products: {
    mobileLegends: number;
    freeFire: number;
    deltaForce: number;
    mixedWithRegion: number;
    mixedWithoutRegion: number;
    mixedWithoutRegionToo: number;
    premiumApp: number;
  };
  /** Denomination ids keyed by a stable label. */
  denominations: Record<string, number>;
  userId: number;
}

function field(key: string, id: string, en: string): AdditionalField {
  return { key, label: { id, en }, type: AdditionalFieldType.NUMBER, required: true, options: [], placeholder: "" };
}

/**
 * Old product names and descriptions from before the seed lost its visible
 * marker, so the one-time migration (scripts/lib/seedGameTopup.ts) can rename
 * already-seeded rows in place instead of leaving them next to new ones.
 */
export const LEGACY_PRODUCT_RENAMES: Readonly<Record<string, { name: string; description?: string }>> = {
  "Mixed Game Regional": { name: "Ragnarok Origin" },
  "Mixed Game Global": { name: "Dragon Raja" },
  "Mixed Game Plain": { name: "Perfect World Mobile" },
  "Streaming App": { name: "Vidio Platinum", description: "Akun Vidio Platinum tanpa iklan, termasuk film, serial, dan siaran olahraga." },
};

/** The buyer's visible profile, shared with the migration. */
export const FIXTURE_BUYER_FULL_NAME = "Budi Santoso";
export const FIXTURE_BUYER_USERNAME = "budisantoso";

/**
 * The buyer (fake Telegram id, not an admin) and the shared settings every Game
 * Top-up manual test needs: the service on for the bot and the web, minimum
 * order 0. Used by the small fixture and by the --bulk seed.
 */
export async function ensureFixtureBuyerAndSettings(prisma: PrismaClient, manifest?: SeedManifest) {
  // A buyer with a fake Telegram id (not an admin).
  const buyerRow = await prisma.user.findUnique({ where: { telegramId: BigInt(FIXTURE_BUYER_TELEGRAM_ID) } });
  if (buyerRow) guardExisting(manifest, "users", buyerRow.id, "the buyer account with the reserved Telegram id");
  const user = await upsertUser(prisma, {
    telegramId: FIXTURE_BUYER_TELEGRAM_ID,
    username: FIXTURE_BUYER_USERNAME,
    fullName: FIXTURE_BUYER_FULL_NAME,
  });
  manifest?.add("users", user.id);

  // Game Top-up enabled for the bot and the web; no minimum order amount.
  const gameService = CUSTOMER_SERVICES.find((s) => s.id === "game_topup")!;
  await setSetting(prisma, gameService.settingKeys.bot, "1");
  await setSetting(prisma, gameService.settingKeys.web, "1");
  await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");
  return user;
}

export async function buildGameTopupFixtures(
  prisma: PrismaClient,
  opts: { manifest?: SeedManifest } = {},
): Promise<GameTopupFixtureIds> {
  const { manifest } = opts;

  const ensureCategory = async (name: string, group: string, sortOrder: number, emoji: string) => {
    const existing = await prisma.category.findUnique({ where: { name } });
    if (existing) {
      guardExisting(manifest, "categories", existing.id, `the category "${name}"`);
      return existing;
    }
    const created = await createCategory(prisma, { name, group, sortOrder, emoji });
    manifest?.add("categories", created.id);
    return created;
  };
  const ensureProduct = async (
    categoryId: number,
    name: string,
    extra: { gameRegion?: string | null; sortOrder?: number; description?: string },
  ) => {
    const existing = await prisma.product.findFirst({ where: { categoryId, name } });
    if (existing) {
      guardExisting(manifest, "products", existing.id, `the product "${name}"`);
      return existing;
    }
    const created = await createCatalogProduct(prisma, { categoryId, name, ...extra });
    manifest?.add("products", created.id);
    return created;
  };
  const ensureDenomination = async (
    productId: number,
    name: string,
    price: string,
    extra: Omit<Parameters<typeof createDenomination>[1], "productId" | "name" | "price" | "type" | "durationLabel"> & { durationLabel?: string },
  ) => {
    const existing = await prisma.denomination.findFirst({ where: { productId, name } });
    if (existing) {
      guardExisting(manifest, "denominations", existing.id, `the denomination "${name}"`);
      return existing;
    }
    const created = await createDenomination(prisma, {
      productId,
      name,
      price: new Decimal(price),
      type: "SHARED",
      durationLabel: name,
      ...extra,
    });
    manifest?.add("denominations", created.id);
    return created;
  };

  const gameCat = await ensureCategory("Game Top Up", CategoryGroup.GAME_TOPUP, 1, "\u{1F3AE}");
  const mixedCat = await ensureCategory("Mixed Games", CategoryGroup.GAME_TOPUP, 2, "\u{1F579}️");
  const premiumCat = await ensureCategory("Premium Apps", CategoryGroup.PREMIUM_APPS, 3, "\u{1F4F1}");

  const ids: Record<string, number> = {};
  const gameDenom = async (
    productId: number,
    label: string,
    qty: number,
    unit: string,
    price: string,
    fields: AdditionalField[],
    extra: { nicknameCheckGameCode?: string; providerInputMapping?: string } = {},
  ) => {
    const d = await ensureDenomination(productId, `${qty} ${unit}`, price, {
      deliveryType: "manual_with_info",
      additionalFields: JSON.stringify(fields),
      qtyValue: qty,
      qtyUnit: unit,
      nicknameCheckGameCode: extra.nicknameCheckGameCode ?? null,
      providerInputMapping: extra.providerInputMapping ?? null,
    });
    ids[label] = d.id;
    return d;
  };

  // Mobile Legends style: ID + Zone, nickname check, Digiflazz key mapping.
  const ml = await ensureProduct(gameCat.id, "Mobile Legends", { gameRegion: "Indonesia", sortOrder: 1 });
  const mlFields = [field("user_id", "ID Pengguna", "User ID"), field("zone_id", "ID Zona", "Zone ID")];
  const mlExtra = {
    nicknameCheckGameCode: "mobile-legends",
    providerInputMapping: JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } }),
  };
  await gameDenom(ml.id, "ml-86", 86, "Diamonds", "20000", mlFields, mlExtra);
  await gameDenom(ml.id, "ml-172", 172, "Diamonds", "40000", mlFields, mlExtra);
  const mlAuto = await ensureDenomination(ml.id, "257 Diamonds Instant", "58000", {
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify(mlFields),
    qtyValue: 257,
    qtyUnit: "Diamonds",
    autoDeliverySource: "digiflazz",
    supplierSku: "ml257",
    ...mlExtra,
  });
  ids["ml-257-auto"] = mlAuto.id;

  // Free Fire style: one field and a region.
  const ff = await ensureProduct(gameCat.id, "Free Fire", { gameRegion: "Indonesia", sortOrder: 2 });
  await gameDenom(ff.id, "ff-70", 70, "Diamonds", "10000", [field("player_id", "ID Pemain", "Player ID")]);
  await gameDenom(ff.id, "ff-140", 140, "Diamonds", "20000", [field("player_id", "ID Pemain", "Player ID")]);

  // Delta Force style: one field, no region.
  const df = await ensureProduct(gameCat.id, "Delta Force", { sortOrder: 3 });
  await gameDenom(df.id, "df-300", 300, "Delta Coins", "45000", [field("uid", "UID", "UID")]);

  // Mixed category: one product with a region, two without.
  const mixedA = await ensureProduct(mixedCat.id, "Ragnarok Origin", { gameRegion: "Indonesia", sortOrder: 1 });
  const mixedB = await ensureProduct(mixedCat.id, "Dragon Raja", { sortOrder: 2 });
  const mixedC = await ensureProduct(mixedCat.id, "Perfect World Mobile", { sortOrder: 3 });
  const one = [field("player_id", "ID Pemain", "Player ID")];
  await gameDenom(mixedA.id, "mixed-a", 100, "Coins", "15000", one);
  await gameDenom(mixedB.id, "mixed-b", 100, "Coins", "16000", one);
  await gameDenom(mixedC.id, "mixed-c", 100, "Coins", "17000", one);

  // Premium Apps control: a plan denomination, no game metadata.
  const app = await ensureProduct(premiumCat.id, "Vidio Platinum", { description: LEGACY_PRODUCT_RENAMES["Streaming App"]!.description });
  const plan = await ensureDenomination(app.id, "1 Month Plan", "55000", {
    durationLabel: "1 Month",
    deliveryType: "manual",
    warrantyDays: 30,
  });
  ids["premium-plan"] = plan.id;

  const user = await ensureFixtureBuyerAndSettings(prisma, manifest);

  return {
    categories: { gameTopup: gameCat.id, mixed: mixedCat.id, premiumApps: premiumCat.id },
    products: {
      mobileLegends: ml.id,
      freeFire: ff.id,
      deltaForce: df.id,
      mixedWithRegion: mixedA.id,
      mixedWithoutRegion: mixedB.id,
      mixedWithoutRegionToo: mixedC.id,
      premiumApp: app.id,
    },
    denominations: ids,
    userId: user.id,
  };
}
