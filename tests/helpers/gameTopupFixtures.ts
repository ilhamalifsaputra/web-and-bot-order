/**
 * Shared Game Top-up fixture builder (Phase 5). One shape, two callers: the
 * order-bot E2E test and the manual seed script (scripts/seed-game-topup-fixtures.ts),
 * so what a developer taps through in `@testtoko_bot` is what the tests assert.
 *
 * Built with the repo's real crud helpers (the same ones tests/e2e/seed.ts and
 * apps/order-bot/test/game-account-input.test.ts use), never raw inserts.
 *
 * Idempotency: when `opts.tag` is given, every created name carries it and each
 * row is found by that deterministic name before it is created, so running the
 * builder twice yields the same ids and no duplicates. Without a tag the builder
 * assumes an empty database (category names are unique, so a second untagged
 * run would fail on the name rather than duplicate).
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

export async function buildGameTopupFixtures(
  prisma: PrismaClient,
  opts: { tag?: string } = {},
): Promise<GameTopupFixtureIds> {
  const tag = opts.tag ?? "";
  const n = (name: string) => `${name}${tag}`;

  const ensureCategory = async (name: string, group: string, sortOrder: number, emoji: string) => {
    const existing = await prisma.category.findUnique({ where: { name: n(name) } });
    return existing ?? createCategory(prisma, { name: n(name), group, sortOrder, emoji });
  };
  const ensureProduct = async (
    categoryId: number,
    name: string,
    extra: { gameRegion?: string | null; sortOrder?: number; description?: string },
  ) => {
    const existing = await prisma.product.findFirst({ where: { categoryId, name: n(name) } });
    return existing ?? createCatalogProduct(prisma, { categoryId, name: n(name), ...extra });
  };
  const ensureDenomination = async (
    productId: number,
    name: string,
    price: string,
    extra: Omit<Parameters<typeof createDenomination>[1], "productId" | "name" | "price" | "type" | "durationLabel"> & { durationLabel?: string },
  ) => {
    const existing = await prisma.denomination.findFirst({ where: { productId, name: n(name) } });
    return existing ?? createDenomination(prisma, {
      productId,
      name: n(name),
      price: new Decimal(price),
      type: "SHARED",
      durationLabel: "N/A",
      ...extra,
    });
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
    supplierSku: "fixture-ml257",
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
  const mixedA = await ensureProduct(mixedCat.id, "Mixed Game Regional", { gameRegion: "Indonesia", sortOrder: 1 });
  const mixedB = await ensureProduct(mixedCat.id, "Mixed Game Global", { sortOrder: 2 });
  const mixedC = await ensureProduct(mixedCat.id, "Mixed Game Plain", { sortOrder: 3 });
  const one = [field("player_id", "ID Pemain", "Player ID")];
  await gameDenom(mixedA.id, "mixed-a", 100, "Coins", "15000", one);
  await gameDenom(mixedB.id, "mixed-b", 100, "Coins", "16000", one);
  await gameDenom(mixedC.id, "mixed-c", 100, "Coins", "17000", one);

  // Premium Apps control: a plan denomination, no game metadata.
  const app = await ensureProduct(premiumCat.id, "Streaming App", { description: "Control product for the Premium Apps flow." });
  const plan = await ensureDenomination(app.id, "1 Month Plan", "55000", {
    durationLabel: "1 Month",
    deliveryType: "manual",
    warrantyDays: 30,
  });
  ids["premium-plan"] = plan.id;

  // A buyer with a fake Telegram id (not an admin).
  const user = await upsertUser(prisma, {
    telegramId: FIXTURE_BUYER_TELEGRAM_ID,
    username: "fixture_buyer",
    fullName: n("Fixture Buyer"),
  });

  // Game Top-up enabled for the bot and the web; no minimum order amount.
  const gameService = CUSTOMER_SERVICES.find((s) => s.id === "game_topup")!;
  await setSetting(prisma, gameService.settingKeys.bot, "1");
  await setSetting(prisma, gameService.settingKeys.web, "1");
  await setSetting(prisma, MIN_ORDER_AMOUNT_IDR_KEY, "0");

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
