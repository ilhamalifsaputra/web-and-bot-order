/**
 * Large, realistic Game Top-up + Premium Apps seed catalog for manual testing
 * (browse pagination, search, the region and edition pickers, button-label
 * limits). Sibling of gameTopupFixtures.ts: same tag convention, same crud
 * helpers, same idempotency (each row is found by its deterministic name
 * before it is created), and the same `--remove` path in
 * scripts/lib/seedGameTopup.ts cleans it because every name carries the tag.
 *
 * Shape (the data lives in the tables below, not in code):
 *  - "Game Top Up" (shared with the small fixture): plain games, no region.
 *  - "Regional Games": every product has a gameRegion (region = server), so
 *    the bot shows the region picker, then the game list for that region.
 *  - "Game Editions": every product has a gameVariant and a gameRegion, so
 *    the bot shows the edition picker, then the region picker.
 *  - "Premium Apps" (shared): plan products (1/3/6/12 months), no game fields.
 *
 * Only fake `supplierSku` values are written; no credentials. Do not import
 * this from product code.
 */
import type { PrismaClient } from "@prisma/client";
import { createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { CategoryGroup } from "@app/core/enums";
import { AdditionalFieldType, type AdditionalField } from "@app/core/deliveryFields";
import { Decimal } from "@app/core/money";

type FieldKind = "player" | "uid" | "userZone";

interface Extra {
  name: string;
  price: number;
}

interface GameSpec {
  name: string;
  unit: string;
  /** Currency quantities, ascending. */
  qtys: readonly number[];
  /** IDR per unit before rounding to the nearest 500. */
  rate: number;
  fields: FieldKind;
  nickname?: string;
  /** Every third denomination is a Digiflazz auto-delivery one with a fake SKU. */
  auto?: boolean;
  /** Passes/bundles with no quantity; their names sit close to the 36-cell button cap. */
  extras?: readonly Extra[];
}

interface RegionalSpec extends GameSpec {
  regions: readonly string[];
}

interface EditionSpec extends GameSpec {
  variants: ReadonlyArray<{ label: string; emoji: string }>;
  regions: readonly string[];
}

const MIN_PRICE = 1_500;
const MAX_PRICE = 2_500_000;
/** Price multipliers per region position (the first region is the base price). */
const REGION_FACTOR = [1, 1.06, 1.12, 1.18] as const;

export const BULK_PLAIN_GAMES: readonly GameSpec[] = [
  { name: "Higgs Domino Island", unit: "M Chips", qtys: [6, 12, 24, 60, 100, 200, 300, 500, 800, 1000, 1500, 2000], rate: 1000, fields: "player", auto: true },
  { name: "Point Blank", unit: "PB Cash", qtys: [1200, 2400, 3600, 6000, 12000, 24000, 36000, 60000, 120000, 240000, 600000, 1200000], rate: 1.05, fields: "player", nickname: "point-blank" },
  { name: "Lords Mobile", unit: "Gems", qtys: [40, 100, 300, 500, 1000, 2000, 3000, 5000, 7000, 10000], rate: 150, fields: "player" },
  { name: "eFootball", unit: "Coins", qtys: [100, 130, 300, 550, 800, 1040, 1600, 2130, 3250, 5700, 12000], rate: 160, fields: "player", auto: true },
  { name: "Stumble Guys", unit: "Gems", qtys: [50, 100, 250, 500, 750, 1000, 1500, 2500, 5000, 10000], rate: 90, fields: "player" },
  { name: "Blood Strike", unit: "Gold", qtys: [100, 300, 500, 1000, 2000, 3000, 5000, 6500, 10000, 20000], rate: 140, fields: "player", nickname: "blood-strike", auto: true },
  { name: "Sausage Man", unit: "Candies", qtys: [60, 120, 180, 300, 600, 980, 1280, 1980, 3280, 6480], rate: 230, fields: "player" },
  { name: "Hay Day", unit: "Diamonds", qtys: [20, 50, 80, 200, 500, 800, 1200, 2500, 4000, 6500, 14000], rate: 200, fields: "player" },
  { name: "Clash of Clans", unit: "Gems", qtys: [80, 160, 500, 800, 1200, 2500, 4000, 6500, 14000], rate: 210, fields: "player", extras: [{ name: "Gold Pass Monthly Subscription", price: 79_000 }] },
  { name: "Clash Royale", unit: "Gems", qtys: [80, 160, 500, 800, 1200, 2500, 4000, 6500, 14000], rate: 210, fields: "player", extras: [{ name: "Pass Royale Monthly Subscription", price: 79_000 }] },
  { name: "Roblox", unit: "Robux", qtys: [40, 80, 160, 240, 400, 800, 1200, 1700, 2500, 4500, 10000], rate: 215, fields: "uid", auto: true },
  { name: "Magic Chess Go Go", unit: "Diamonds", qtys: [5, 12, 19, 28, 44, 59, 86, 172, 257, 344, 429, 514], rate: 235, fields: "userZone", nickname: "magic-chess-go-go" },
  { name: "Honor of Kings", unit: "Tokens", qtys: [16, 80, 240, 400, 560, 800, 1200, 2400, 4000, 8000], rate: 270, fields: "player", nickname: "honor-of-kings" },
  { name: "Growtopia", unit: "World Lock", qtys: [1, 2, 5, 10, 20, 30, 50, 100, 200, 500, 1000], rate: 1500, fields: "player" },
  { name: "League of Legends Wild Rift", unit: "Wild Cores", qtys: [65, 125, 250, 425, 725, 1000, 1450, 1850, 2500, 4200, 8750], rate: 160, fields: "player" },
  { name: "Tower of Fantasy", unit: "Tanium", qtys: [60, 120, 300, 600, 980, 1480, 1980, 3280, 6480], rate: 235, fields: "uid" },
  { name: "Identity V", unit: "Echoes", qtys: [60, 120, 300, 600, 980, 1480, 1980, 3280, 6480], rate: 235, fields: "player" },
  { name: "8 Ball Pool", unit: "Cash", qtys: [50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000], rate: 250, fields: "uid" },
];

export const BULK_REGIONAL_GAMES: readonly RegionalSpec[] = [
  {
    name: "Mobile Legends", unit: "Diamonds", rate: 235, fields: "userZone", nickname: "mobile-legends", auto: true,
    qtys: [5, 12, 19, 28, 44, 59, 86, 172, 257, 344, 429, 514, 706, 878, 1038, 2195, 3688, 5532],
    regions: ["Indonesia", "Malaysia", "Philippines", "Global"],
    extras: [
      { name: "Weekly Diamond Pass", price: 28_000 },
      { name: "Twilight Pass Season Bundle Deluxe", price: 145_000 },
      { name: "Monthly Super Value Diamond Package", price: 119_000 },
    ],
  },
  {
    name: "Free Fire", unit: "Diamonds", rate: 143, fields: "player", nickname: "free-fire", auto: true,
    qtys: [5, 12, 50, 70, 140, 355, 720, 1450, 2180, 3640, 7290],
    regions: ["Indonesia", "Malaysia", "Thailand"],
    extras: [{ name: "Membership Mingguan", price: 29_000 }, { name: "Membership Bulanan", price: 119_000 }],
  },
  {
    name: "PUBG Mobile", unit: "UC", rate: 155, fields: "player", nickname: "pubg-mobile",
    qtys: [60, 120, 325, 660, 985, 1320, 1800, 2460, 3850, 5650, 8100, 11950, 16200],
    regions: ["Indonesia", "Global"],
    extras: [{ name: "Elite Pass Plus Season Bundle Pack", price: 149_000 }],
  },
  {
    name: "Genshin Impact", unit: "Genesis Crystals", rate: 245, fields: "uid", nickname: "genshin-impact",
    qtys: [60, 120, 330, 660, 1090, 1640, 2240, 3010, 3880, 5470, 6480, 8080],
    regions: ["Asia", "America", "Europe", "TW, HK, MO"],
    extras: [{ name: "Blessing of the Welkin Moon", price: 76_000 }, { name: "Welkin Moon Monthly Pass Premium", price: 79_000 }],
  },
  {
    name: "Honkai Star Rail", unit: "Oneiric Shards", rate: 245, fields: "uid", nickname: "honkai-star-rail",
    qtys: [40, 60, 120, 300, 600, 980, 1480, 1980, 2480, 3280, 4480, 6480],
    regions: ["Asia", "America", "Europe"],
    extras: [{ name: "Express Supply Pass Monthly", price: 76_000 }],
  },
  {
    name: "Valorant", unit: "VP", rate: 160, fields: "uid", nickname: "valorant",
    qtys: [125, 250, 420, 700, 1000, 1375, 2000, 2400, 3400, 4000, 5350, 8150],
    regions: ["Indonesia", "Singapore", "Philippines"],
    extras: [{ name: "Battle Pass Premium Plus Bundle", price: 149_000 }],
  },
  {
    name: "Call of Duty Mobile", unit: "CP", rate: 150, fields: "uid", nickname: "call-of-duty-mobile", auto: true,
    qtys: [31, 62, 128, 321, 633, 1268, 1900, 2500, 3200, 5000, 6400, 12800],
    regions: ["Garena Indonesia", "Global"],
  },
  {
    name: "Arena of Valor", unit: "Vouchers", rate: 270, fields: "player", nickname: "arena-of-valor",
    qtys: [16, 40, 80, 240, 400, 560, 800, 1200, 1600, 2400, 4000, 8000],
    regions: ["Indonesia", "Thailand"],
  },
  {
    name: "Ragnarok M", unit: "Zeny", rate: 205, fields: "userZone",
    qtys: [30, 60, 150, 300, 600, 980, 1480, 1980, 3280, 6480],
    regions: ["Indonesia", "SEA"],
  },
  {
    name: "Wuthering Waves", unit: "Lunite", rate: 245, fields: "uid", auto: true,
    qtys: [60, 120, 300, 600, 980, 1480, 1980, 2480, 3280, 4480, 6480, 9680],
    regions: ["Asia", "America", "Europe"],
    extras: [{ name: "Lunite Subscription Monthly", price: 79_000 }],
  },
  {
    name: "Zenless Zone Zero", unit: "Monochrome", rate: 245, fields: "uid",
    qtys: [60, 120, 300, 600, 980, 1480, 1980, 2480, 3280, 4480, 6480, 9680],
    regions: ["Asia", "America", "Europe"],
    extras: [{ name: "Inter-Knot Membership Monthly", price: 79_000 }],
  },
  {
    name: "Marvel Rivals", unit: "Lattice", rate: 150, fields: "uid",
    qtys: [100, 200, 500, 1000, 1500, 2000, 3000, 5000, 7500, 10000, 15000],
    regions: ["Global", "Asia"],
  },
];

export const BULK_EDITION_GAMES: readonly EditionSpec[] = [
  {
    name: "Arena Breakout", unit: "Bonds", rate: 220, fields: "uid", auto: true,
    qtys: [60, 120, 300, 600, 980, 1480, 1980, 3280, 6480, 9680],
    variants: [{ label: "Standard", emoji: "\u{1F52B}" }, { label: "Infinite", emoji: "♾️" }],
    regions: ["Global", "Indonesia"],
  },
  {
    name: "PUBG", unit: "UC", rate: 155, fields: "player",
    qtys: [60, 120, 325, 660, 985, 1320, 1800, 2460, 3850, 5650, 8100],
    variants: [{ label: "Mobile", emoji: "\u{1F4F1}" }, { label: "New State", emoji: "\u{1F680}" }],
    regions: ["Indonesia", "Global"],
  },
];

interface PremiumSpec {
  name: string;
  description: string;
  /** Months to IDR price, ascending. */
  plans: ReadonlyArray<readonly [number, number]>;
}

export const BULK_PREMIUM_APPS: readonly PremiumSpec[] = [
  { name: "Netflix Premium", description: "Netflix Premium shared profile.", plans: [[1, 55_000], [3, 150_000], [6, 285_000], [12, 540_000]] },
  { name: "Spotify Premium", description: "Spotify Premium individual plan.", plans: [[1, 25_000], [3, 70_000], [6, 135_000], [12, 250_000]] },
  { name: "YouTube Premium", description: "YouTube Premium without ads, with background play.", plans: [[1, 20_000], [3, 55_000], [12, 200_000]] },
  { name: "Canva Pro", description: "Canva Pro team seat.", plans: [[1, 15_000], [3, 40_000], [12, 120_000]] },
  { name: "AI Chat Plus", description: "AI assistant subscription, plus tier.", plans: [[1, 85_000], [3, 240_000], [6, 470_000], [12, 900_000]] },
  { name: "Disney+ Premium", description: "Disney+ Premium shared profile.", plans: [[1, 35_000], [3, 95_000], [12, 330_000]] },
  { name: "Microsoft 365 Personal", description: "Microsoft 365 Personal with 1 TB cloud storage.", plans: [[1, 30_000], [6, 150_000], [12, 280_000]] },
  { name: "Google One 2TB", description: "Google One 2 TB cloud storage plan.", plans: [[1, 40_000], [3, 110_000], [6, 210_000], [12, 400_000]] },
];

function numberField(key: string, id: string, en: string): AdditionalField {
  return { key, label: { id, en }, type: AdditionalFieldType.NUMBER, required: true, options: [], placeholder: "" };
}

function fieldsFor(kind: FieldKind): AdditionalField[] {
  if (kind === "userZone") return [numberField("user_id", "ID Pengguna", "User ID"), numberField("zone_id", "ID Zona", "Zone ID")];
  if (kind === "uid") return [numberField("uid", "UID", "UID")];
  return [numberField("player_id", "ID Pemain", "Player ID")];
}

function slugPart(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

interface PlannedDenomination {
  name: string;
  qty: number | null;
  unit: string | null;
  price: number;
  sku: string | null;
}

/** Deterministic, strictly ascending denominations for one product. */
export function planGameDenominations(spec: GameSpec, regionIndex: number, skuKey: string): PlannedDenomination[] {
  const factor = REGION_FACTOR[Math.min(regionIndex, REGION_FACTOR.length - 1)]!;
  const out: PlannedDenomination[] = [];
  let last = 0;
  spec.qtys.forEach((qty, i) => {
    let price = Math.max(MIN_PRICE, Math.round((qty * spec.rate * factor) / 500) * 500);
    if (price <= last) price = last + 500;
    if (price > MAX_PRICE) return;
    last = price;
    out.push({
      name: `${qty} ${spec.unit}`,
      qty,
      unit: spec.unit,
      price,
      sku: spec.auto && i % 3 === 0 ? `fixture-${skuKey}-${qty}` : null,
    });
  });
  for (const extra of spec.extras ?? []) {
    out.push({ name: extra.name, qty: null, unit: null, price: Math.round((extra.price * factor) / 500) * 500, sku: null });
  }
  return out;
}

export interface BulkCatalogResult {
  categories: { gameTopUp: number; regional: number; editions: number; premiumApps: number };
  /** Distinct game titles. */
  games: number;
  /** Distinct (game, region) pairs across all game products. */
  regions: number;
  gameProducts: number;
  premiumProducts: number;
  products: number;
  denominations: number;
  /** Product ids by "<category key>/<name>/<variant>/<region>" for assertions. */
  productIds: Record<string, number>;
}

export async function buildBulkGameTopupCatalog(
  prisma: PrismaClient,
  opts: { tag?: string } = {},
): Promise<BulkCatalogResult> {
  const tag = opts.tag ?? "";
  const n = (name: string) => `${name}${tag}`;

  const ensureCategory = async (name: string, group: string, sortOrder: number, emoji: string) => {
    const existing = await prisma.category.findUnique({ where: { name: n(name) } });
    return existing ?? createCategory(prisma, { name: n(name), group, sortOrder, emoji });
  };
  const gameCat = await ensureCategory("Game Top Up", CategoryGroup.GAME_TOPUP, 1, "\u{1F3AE}");
  const regionalCat = await ensureCategory("Regional Games", CategoryGroup.GAME_TOPUP, 4, "\u{1F30F}");
  const editionsCat = await ensureCategory("Game Editions", CategoryGroup.GAME_TOPUP, 5, "\u{1F3AF}");
  const premiumCat = await ensureCategory("Premium Apps", CategoryGroup.PREMIUM_APPS, 3, "\u{1F4F1}");

  const productIds: Record<string, number> = {};
  const gameTitles = new Set<string>();
  const regionPairs = new Set<string>();
  let gameProducts = 0;
  let denominations = 0;

  const ensureProduct = async (
    categoryId: number,
    name: string,
    extra: { gameRegion?: string | null; gameVariant?: string | null; gameVariantEmoji?: string | null; sortOrder: number; description?: string },
  ) => {
    const existing = await prisma.product.findFirst({
      where: { categoryId, name: n(name), gameRegion: extra.gameRegion ?? null, gameVariant: extra.gameVariant ?? null },
    });
    return existing ?? createCatalogProduct(prisma, { categoryId, name: n(name), ...extra });
  };

  /** Creates the missing denominations of one product; the existing names come from a single query. */
  const ensureDenominations = async (
    productId: number,
    planned: ReadonlyArray<{ name: string; price: number; durationLabel?: string; create: (name: string) => Parameters<typeof createDenomination>[1] }>,
  ) => {
    const have = new Set((await prisma.denomination.findMany({ where: { productId }, select: { name: true } })).map((d) => d.name));
    for (const p of planned) {
      denominations += 1;
      if (have.has(n(p.name))) continue;
      await createDenomination(prisma, p.create(n(p.name)));
    }
  };

  const seedGame = async (
    categoryId: number,
    categoryKey: string,
    spec: GameSpec,
    placement: { region: string | null; regionIndex: number; variant?: { label: string; emoji: string } | null; sortOrder: number },
  ) => {
    const product = await ensureProduct(categoryId, spec.name, {
      gameRegion: placement.region,
      gameVariant: placement.variant?.label ?? null,
      gameVariantEmoji: placement.variant?.emoji ?? null,
      sortOrder: placement.sortOrder,
    });
    productIds[`${categoryKey}/${spec.name}/${placement.variant?.label ?? ""}/${placement.region ?? ""}`] = product.id;
    gameProducts += 1;
    gameTitles.add(spec.name);
    if (placement.region) regionPairs.add(`${spec.name}|${placement.region}`);

    const fields = JSON.stringify(fieldsFor(spec.fields));
    const skuKey = slugPart(`${spec.name}-${placement.variant?.label ?? ""}-${placement.region ?? ""}`);
    const mapping =
      spec.fields === "userZone"
        ? JSON.stringify({ digiflazz: { keys: ["user_id", "zone_id"], separator: "" } })
        : spec.fields === "uid"
          ? JSON.stringify({ digiflazz: { keys: ["uid"], separator: "" } })
          : JSON.stringify({ digiflazz: { keys: ["player_id"], separator: "" } });
    const plan = planGameDenominations(spec, placement.regionIndex, skuKey);
    await ensureDenominations(
      product.id,
      plan.map((d, i) => ({
        name: d.name,
        price: d.price,
        create: (name) => ({
          productId: product.id,
          name,
          price: new Decimal(d.price),
          type: "SHARED",
          durationLabel: name,
          deliveryType: "manual_with_info",
          additionalFields: fields,
          qtyValue: d.qty,
          qtyUnit: d.unit,
          sortOrder: i,
          nicknameCheckGameCode: spec.nickname ?? null,
          providerInputMapping: spec.nickname || d.sku ? mapping : null,
          ...(d.sku ? { autoDeliverySource: "digiflazz", supplierSku: d.sku } : {}),
        }),
      })),
    );
  };

  for (const [i, spec] of BULK_PLAIN_GAMES.entries()) {
    await seedGame(gameCat.id, "plain", spec, { region: null, regionIndex: 0, sortOrder: 10 + i });
  }
  for (const [i, spec] of BULK_REGIONAL_GAMES.entries()) {
    for (const [r, region] of spec.regions.entries()) {
      await seedGame(regionalCat.id, "regional", spec, { region, regionIndex: r, sortOrder: i * 10 + r });
    }
  }
  for (const [i, spec] of BULK_EDITION_GAMES.entries()) {
    for (const [v, variant] of spec.variants.entries()) {
      for (const [r, region] of spec.regions.entries()) {
        await seedGame(editionsCat.id, "editions", spec, { region, regionIndex: r, variant, sortOrder: i * 100 + v * 10 + r });
      }
    }
  }

  // Premium Apps: plan denominations, the usual plan flow, no game fields.
  for (const [i, app] of BULK_PREMIUM_APPS.entries()) {
    const product = await ensureProduct(premiumCat.id, app.name, { sortOrder: 10 + i, description: app.description });
    productIds[`premium/${app.name}//`] = product.id;
    await ensureDenominations(
      product.id,
      app.plans.map(([months, price], p) => ({
        name: `${months} ${months === 1 ? "Month" : "Months"} Plan`,
        price,
        create: (name) => ({
          productId: product.id,
          name,
          price: new Decimal(price),
          type: "SHARED",
          durationLabel: `${months} ${months === 1 ? "Month" : "Months"}`,
          deliveryType: "manual",
          warrantyDays: months * 30,
          sortOrder: p,
        }),
      })),
    );
  }

  return {
    categories: { gameTopUp: gameCat.id, regional: regionalCat.id, editions: editionsCat.id, premiumApps: premiumCat.id },
    games: gameTitles.size,
    regions: regionPairs.size,
    gameProducts,
    premiumProducts: BULK_PREMIUM_APPS.length,
    products: gameProducts + BULK_PREMIUM_APPS.length,
    denominations,
    productIds,
  };
}
