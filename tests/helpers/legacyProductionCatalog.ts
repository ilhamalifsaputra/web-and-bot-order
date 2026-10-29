/**
 * A production-like LEGACY Game Top-up catalog: what the shop's database looked
 * like after the Digiflazz import wizard ran, BEFORE any game-level grouping,
 * region backfill or edition clean-up. Test-only (no seed marker needed); used by
 * apps/order-bot/test/legacy-production-catalog.test.ts to reproduce the bugs a
 * buyer sees in the real bot. Do not import this from product code.
 *
 * Shape: ONE GAME_TOPUP category ("Game Top Up") holding every imported product
 * flat, plus a small Premium Apps category as the control. No product has a
 * `gameRegion` (that column only exists on rows created after the region work),
 * every name / digiflazzBrand / gameVariant is exactly what the importer writes.
 *
 * Importer assumptions (packages/db/src/crud/digiflazz.ts
 * groupDigiflazzPriceListByBrand + importDigiflazzBrand, and
 * packages/core/src/suppliers/digiflazz.ts digiflazzGroupKey):
 *  - Product.name === Product.digiflazzBrand === the group's composite name.
 *  - A brand whose rows report >= 2 distinct Digiflazz `type` values is split:
 *    the base (type "Umum"/empty) subset keeps the brand name with
 *    gameVariant "Umum"; every other type becomes `${rawBrand} ${type}` with
 *    gameVariant = that type. A brand with one type is NOT split (gameVariant
 *    null). A trailing "(Region)" on productName becomes `${brand} (${Region})`
 *    with the raw paren text kept (gameRegion stays NULL until a backfill).
 *  - "MOBILE LEGENDS" (upper-case brand) reports `type` Indonesia / Malaysia /
 *    Russia, so it splits into three products whose gameVariant is a REGION
 *    ("MOBILE LEGENDS Indonesia", ...): the "Malaysia is an edition" bug.
 *  - "Mobile Legends" (mixed-case, a different rawBrand) has rows "(BR)" and
 *    "(PH)" of type Umum plus rows of type Global: "(BR)" / "(PH)" are the base
 *    subsets (gameVariant "Umum"), "Mobile Legends Global" is the Global split.
 *  - "Delta Force" reports Umum + Garena, "Arena Breakout" reports Umum +
 *    Infinite, "Valorant" reports Umum + Malaysia; the shop imported only the
 *    Malaysia subset of Valorant ("Valorant Malaysia", gameVariant Malaysia).
 *  - "Where Winds Meet", "Free Fire", "Growtopia" report a single type, so they
 *    are unsplit (gameVariant null).
 *  - Denominations are created like createDigiflazzDenomination: name = the
 *    productName with the region suffix stripped, supplierSku = buyer SKU,
 *    supplierRawName = the raw productName, autoDeliverySource "digiflazz",
 *    deliveryType manual_with_info. qtyValue/qtyUnit stand for the values the
 *    detection pass / admin filled in afterwards (the pack buttons need them).
 *  - Product photos use the real shape: webImageUrl (an upload path) with the
 *    cached Telegram imageFileId; the bot then sends a photo bubble. A fake file
 *    id is fine, the fake Telegram transport accepts any photo.
 */
import type { PrismaClient } from "@prisma/client";
import { createCategory, createCatalogProduct, createDenomination, setSetting } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { Decimal } from "@app/core/money";
import { ensureFixtureBuyerAndSettings } from "./gameTopupFixtures";

/** The shop banner, as a legacy Telegram file id (`banner_image` setting). */
export const LEGACY_BANNER_FILE_ID = "AgACAgUAAxkBAAIFAKE_legacy_shop_banner";

export interface LegacyCatalogIds {
  userId: number;
  categories: { gameTopup: number; premiumApps: number };
  /** Product id by exact product name ("MOBILE LEGENDS Indonesia", ...). */
  products: Record<string, number>;
  /** Denomination ids per product name, in creation order. */
  denominations: Record<string, number[]>;
}

type PackSpec = { qty: number; price: number } | { name: string; price: number };

interface LegacyProduct {
  name: string;
  /** Digiflazz `type`-split edition (Product.gameVariant). */
  gameVariant: string | null;
  unit: string;
  fields: "userZone" | "player" | "uid";
  /** Pack quantities with IDR prices, ascending. */
  packs: ReadonlyArray<readonly [number, number]>;
  /** Passes / bundles with no quantity. */
  passes?: ReadonlyArray<readonly [string, number]>;
  /** A fake uploaded photo (webImageUrl + cached Telegram file id). */
  image?: boolean;
}

function numberField(key: string, id: string, en: string): AdditionalField {
  return { key, label: { id, en }, type: AdditionalFieldType.NUMBER, required: true, options: [], placeholder: "" };
}

function fieldsFor(kind: LegacyProduct["fields"]): AdditionalField[] {
  if (kind === "userZone") return [numberField("user_id", "ID Pengguna", "User ID"), numberField("zone_id", "ID Zona", "Zone ID")];
  if (kind === "uid") return [numberField("uid", "UID", "UID")];
  return [numberField("player_id", "ID Pemain", "Player ID")];
}

/** Ascending diamond-like packs: `count` packs of `unitPrice` IDR per unit, base quantity doubling. */
function ladder(count: number, unitPrice: number, base = 5): ReadonlyArray<readonly [number, number]> {
  const qtys = [base, 12, 19, 28, 44, 59, 86, 172, 257, 344, 429, 514, 706, 878, 1038, 1240, 1412, 1738, 2195, 2901, 3688, 4390, 5532, 7060, 9288];
  return qtys.slice(0, count).map((q) => [q, Math.max(1_500, Math.round((q * unitPrice) / 500) * 500)] as const);
}

const PRODUCTS: readonly LegacyProduct[] = [
  // "MOBILE LEGENDS": Digiflazz type = region, so a region lives in gameVariant. Indonesia is big (2 pack pages).
  { name: "MOBILE LEGENDS Indonesia", gameVariant: "Indonesia", unit: "Diamonds", fields: "userZone", packs: ladder(23, 285), passes: [["Weekly Diamond Pass", 28_000], ["Twilight Pass", 145_000]], image: true },
  { name: "MOBILE LEGENDS Malaysia", gameVariant: "Malaysia", unit: "Diamonds", fields: "userZone", packs: ladder(7, 310) },
  { name: "MOBILE LEGENDS Russia", gameVariant: "Russia", unit: "Diamonds", fields: "userZone", packs: ladder(6, 330) },
  // "Mobile Legends": "(BR)" / "(PH)" are base subsets of a type-split brand (variant "Umum"); the raw paren text stays in the name.
  { name: "Mobile Legends (BR)", gameVariant: "Umum", unit: "Diamonds", fields: "userZone", packs: ladder(6, 320) },
  { name: "Mobile Legends (PH)", gameVariant: "Umum", unit: "Diamonds", fields: "userZone", packs: ladder(8, 300) },
  { name: "Mobile Legends Global", gameVariant: "Global", unit: "Diamonds", fields: "userZone", packs: ladder(5, 340) },
  { name: "Where Winds Meet", gameVariant: null, unit: "Echo Beads", fields: "uid", packs: [[60, 15_000], [300, 75_000], [980, 235_000], [1980, 470_000], [3280, 780_000]] },
  { name: "Delta Force", gameVariant: "Umum", unit: "Delta Coins", fields: "uid", packs: [[60, 9_000], [300, 45_000], [680, 100_000], [1280, 190_000], [1980, 290_000], [3280, 480_000]], image: true },
  { name: "Delta Force Garena", gameVariant: "Garena", unit: "Delta Coins", fields: "uid", packs: [[60, 9_500], [300, 47_500], [680, 105_000], [1280, 200_000]] },
  { name: "Free Fire", gameVariant: null, unit: "Diamonds", fields: "player", packs: ladder(9, 150, 5), passes: [["Membership Mingguan", 29_000], ["Membership Bulanan", 119_000]], image: true },
  { name: "Growtopia", gameVariant: null, unit: "World Lock", fields: "player", packs: [[1, 1_500], [2, 3_000], [5, 7_500], [10, 15_000], [20, 30_000], [50, 75_000]] },
  { name: "Arena Breakout", gameVariant: "Umum", unit: "Bonds", fields: "uid", packs: [[60, 14_000], [300, 68_000], [980, 215_000], [1980, 430_000]] },
  { name: "Arena Breakout Infinite", gameVariant: "Infinite", unit: "Bonds", fields: "uid", packs: [[60, 14_500], [300, 70_000], [980, 220_000], [1980, 440_000]] },
  { name: "Valorant Malaysia", gameVariant: "Malaysia", unit: "VP", fields: "uid", packs: [[125, 20_000], [420, 65_000], [700, 105_000], [1375, 205_000], [2400, 350_000]], image: true },
];

/** Build the legacy production-like catalog in an empty database and return its ids. */
export async function buildLegacyProductionLikeCatalog(prisma: PrismaClient): Promise<LegacyCatalogIds> {
  const user = await ensureFixtureBuyerAndSettings(prisma);
  // The shop banner every Game screen is rendered under.
  await setSetting(prisma, "banner_image", LEGACY_BANNER_FILE_ID);

  const gameCat = await createCategory(prisma, { name: "Game Top Up", group: CategoryGroup.GAME_TOPUP, sortOrder: 1, emoji: "\u{1F3AE}" });
  const premiumCat = await createCategory(prisma, { name: "Premium Apps", group: CategoryGroup.PREMIUM_APPS, sortOrder: 2, emoji: "\u{1F4F1}" });

  const products: Record<string, number> = {};
  const denominations: Record<string, number[]> = {};
  let sku = 0;

  for (const [index, spec] of PRODUCTS.entries()) {
    const slug = spec.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const product = await createCatalogProduct(prisma, {
      categoryId: gameCat.id,
      name: spec.name,
      digiflazzBrand: spec.name,
      gameVariant: spec.gameVariant,
      // gameRegion deliberately omitted: NULL, as before the region backfill.
      sortOrder: index,
      ...(spec.image ? { webImageUrl: `/uploads/products/${slug}.jpg`, imageFileId: `AgACAgUAAxkBAAIFAKE_${slug}` } : {}),
    });
    products[spec.name] = product.id;
    denominations[spec.name] = [];
    const fields = JSON.stringify(fieldsFor(spec.fields));
    const mapping = JSON.stringify({ digiflazz: { keys: fieldsFor(spec.fields).map((f) => f.key), separator: "" } });

    const specs: PackSpec[] = [
      ...spec.packs.map(([qty, price]) => ({ qty, price })),
      ...(spec.passes ?? []).map(([name, price]) => ({ name, price })),
    ];
    for (const [i, pack] of specs.entries()) {
      sku += 1;
      const qty = "qty" in pack ? pack.qty : null;
      const name = "qty" in pack ? `${pack.qty} ${spec.unit}` : pack.name;
      const rawName = `${spec.name.toUpperCase()} ${name}`;
      const denom = await createDenomination(prisma, {
        productId: product.id,
        name,
        price: new Decimal(pack.price),
        costPrice: new Decimal(Math.round(pack.price * 0.96)),
        type: "SHARED",
        durationLabel: name,
        deliveryType: "manual_with_info",
        additionalFields: fields,
        qtyValue: qty,
        qtyUnit: qty === null ? null : spec.unit,
        sortOrder: i,
        autoDeliverySource: "digiflazz",
        supplierSku: `legacy-sku-${sku}`,
        supplierRawName: rawName,
        providerInputMapping: mapping,
      });
      denominations[spec.name]!.push(denom.id);
    }
  }

  // Premium Apps control: plan products with the numbered picker, no game fields.
  for (const [i, [app, monthly]] of ([["Vidio Platinum", 55_000], ["Spotify Premium", 25_000]] as const).entries()) {
    const product = await createCatalogProduct(prisma, { categoryId: premiumCat.id, name: app, sortOrder: i });
    products[app] = product.id;
    denominations[app] = [];
    for (const [p, months] of [1, 3].entries()) {
      const d = await createDenomination(prisma, {
        productId: product.id,
        name: `${months} ${months === 1 ? "Month" : "Months"}`,
        price: new Decimal(months === 1 ? monthly : Math.round((monthly * 2.7) / 500) * 500),
        type: "SHARED",
        durationLabel: `${months} ${months === 1 ? "Month" : "Months"}`,
        deliveryType: "manual",
        warrantyDays: months * 30,
        sortOrder: p,
      });
      denominations[app]!.push(d.id);
    }
  }

  return { userId: user.id, categories: { gameTopup: gameCat.id, premiumApps: premiumCat.id }, products, denominations };
}
