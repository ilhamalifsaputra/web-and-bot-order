import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceForCategoryGroup } from "@app/core/services";
import { CategoryGroup } from "@app/core/enums";
import { MAX_LABEL_WIDTH, MAX_LABEL_BYTES, NARROW_LABEL_WIDTH, visualWidth } from "@app/core/buttonLimits";
import { makeTestDb, type TestDb } from "./testdb";
import { buildBulkGameTopupCatalog, BULK_GAMES } from "./gameTopupBulkCatalog";
import { buildGameTopupFixtures } from "./gameTopupFixtures";
import { SeedManifest } from "./seedManifest";
import { expectNoVisibleMarkers } from "./seedMarkers";

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });

/** 32 per-game categories + Premium Apps; 60 game products + 8 Premium Apps products. */
const EXPECTED_TOTAL = { categories: 33, products: 68, denominations: 758 };

const counts = async () => ({
  categories: await db.prisma.category.count(),
  products: await db.prisma.product.count(),
  denominations: await db.prisma.denomination.count(),
});

describe("buildBulkGameTopupCatalog", () => {
  it("builds a large per-game catalog that is valid, separated by family and idempotent", async () => {
    const first = await buildBulkGameTopupCatalog(db.prisma);
    const afterFirst = await counts();
    expect(first.games).toBeGreaterThanOrEqual(30);
    expect(first.gameCategories).toBe(BULK_GAMES.length);
    expect(first.products).toBeGreaterThanOrEqual(60);
    expect(first.denominations).toBeGreaterThanOrEqual(600);
    expect(first.premiumProducts).toBe(8);
    expect(first.regions).toBeGreaterThan(20);
    expect(afterFirst.products).toBe(first.products);
    expect(afterFirst.denominations).toBe(first.denominations);

    const second = await buildBulkGameTopupCatalog(db.prisma);
    expect(await counts()).toEqual(afterFirst);
    expect(second).toEqual(first);

    // Family comes from the category group, never from names.
    const products = await db.prisma.product.findMany({ include: { category: true, denominations: true } });
    for (const p of products) {
      if (p.category.group === CategoryGroup.GAME_TOPUP) {
        expect(serviceForCategoryGroup(p.category.group as never).id).toBe("game_topup");
        expect(p.denominations.length).toBeGreaterThanOrEqual(8);
        expect(p.denominations.length).toBeLessThanOrEqual(24);
        for (const d of p.denominations) {
          expect(d.additionalFields).toBeTruthy();
          const keys = (JSON.parse(d.additionalFields!) as Array<{ key: string }>).map((f) => f.key);
          expect(keys.length === 1 || keys.join() === "user_id,zone_id").toBe(true);
        }
      } else {
        expect(p.category.group).toBe(CategoryGroup.PREMIUM_APPS);
        expect(serviceForCategoryGroup(p.category.group as never).id).toBe("premium_apps");
        expect(p.gameRegion).toBeNull();
        expect(p.gameVariant).toBeNull();
        expect(p.denominations.length).toBeGreaterThanOrEqual(3);
        expect(p.denominations.length).toBeLessThanOrEqual(6);
        for (const d of p.denominations) {
          expect(d.additionalFields ?? null).toBeNull();
          expect(d.qtyValue).toBeNull();
          expect(d.supplierSku).toBeNull();
          expect(d.nicknameCheckGameCode).toBeNull();
        }
      }
    }

    // One category per game; every GAME_TOPUP scope is pickable the way the bot's pickers need it:
    // all products of the scope carry the dimension, or none do.
    const gameCats = await db.prisma.category.findMany({ where: { group: CategoryGroup.GAME_TOPUP }, orderBy: { sortOrder: "asc" } });
    expect(gameCats.length).toBe(BULK_GAMES.length);
    expect(gameCats.length).toBeGreaterThanOrEqual(30);
    expect(await db.prisma.category.count()).toBe(gameCats.length + 1);
    const regionNames = new Set<string>();
    for (const g of BULK_GAMES) for (const r of g.regions ?? []) regionNames.add(r);
    for (const c of gameCats) {
      for (const r of regionNames) expect(c.name).not.toContain(r);
      expect(c.name).not.toMatch(/regional|edition|game top up|mixed/i);
      const inCat = products.filter((p) => p.categoryId === c.id);
      expect(inCat.length).toBeGreaterThan(0);
      expect(new Set(inCat.map((p) => p.name))).toEqual(new Set([c.name]));
      expect(inCat.every((p) => p.gameVariant) || inCat.every((p) => !p.gameVariant)).toBe(true);
      for (const v of new Set(inCat.map((p) => p.gameVariant))) {
        const scope = inCat.filter((p) => p.gameVariant === v);
        expect(scope.every((p) => p.gameRegion) || scope.every((p) => !p.gameRegion)).toBe(true);
        const regions = scope.map((p) => p.gameRegion);
        expect(new Set(regions).size).toBe(regions.length);
        if (v) expect(scope.every((p) => p.gameVariantEmoji)).toBe(true);
      }
      const spec = BULK_GAMES.find((g) => g.name === c.name)!;
      expect(c.emoji).toBe(spec.platform === "pc" ? "\u{1F5A5}️" : "\u{1F3AE}");
    }
    // Mobile games come first, then PC games (the data model has no subcategories: emoji and sortOrder only).
    const platforms = gameCats.map((c) => BULK_GAMES.find((g) => g.name === c.name)!.platform);
    expect(platforms).toEqual([...platforms].sort((a, b) => (a === b ? 0 : a === "mobile" ? -1 : 1)));
    expect(platforms).toContain("pc");

    const multiRegion = BULK_GAMES.filter((g) => !g.variants && (g.regions?.length ?? 0) >= 2);
    expect(multiRegion.length).toBeGreaterThanOrEqual(10);
    expect(multiRegion.every((g) => g.regions!.length <= 5)).toBe(true);
    const editions = BULK_GAMES.filter((g) => g.variants);
    expect(editions.length).toBeGreaterThanOrEqual(2);
    expect(editions.length).toBeLessThanOrEqual(3);
    expect(BULK_GAMES.some((g) => !g.regions)).toBe(true);
    expect(BULK_GAMES.some((g) => g.regions?.length === 1)).toBe(true);

    const mlCat = gameCats.find((c) => c.name === "Mobile Legends")!;
    const mlRegions = products.filter((p) => p.categoryId === mlCat.id).map((p) => p.gameRegion).sort();
    expect(mlRegions).toEqual(
      ["\u{1F1EE}\u{1F1E9} Indonesia", "\u{1F1F2}\u{1F1FE} Malaysia", "\u{1F1F5}\u{1F1ED} Philippines", "\u{1F310} Global"].sort(),
    );
    for (const p of products) if (p.gameRegion) expect(visualWidth(p.gameRegion)).toBeLessThanOrEqual(NARROW_LABEL_WIDTH);
    const premiumCat = await db.prisma.category.findUniqueOrThrow({ where: { name: "Premium Apps" } });
    expect(first.categories.premiumApps).toBe(premiumCat.id);

    // No duplicate (product, name); prices ascending among quantity packs; labels fit a phone.
    const denoms = await db.prisma.denomination.findMany({ orderBy: [{ productId: "asc" }, { sortOrder: "asc" }] });
    const seen = new Set<string>();
    let withNickname = 0;
    let withSku = 0;
    let nearCap = 0;
    for (const d of denoms) {
      const key = `${d.productId}|${d.name}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      const bare = d.name;
      expect(visualWidth(bare)).toBeLessThanOrEqual(MAX_LABEL_WIDTH);
      expect(Buffer.byteLength(bare)).toBeLessThanOrEqual(MAX_LABEL_BYTES);
      if (visualWidth(bare) >= 33) nearCap += 1;
      const price = Number(d.price);
      expect(price).toBeGreaterThanOrEqual(1_500);
      expect(price).toBeLessThanOrEqual(2_500_000);
      if (d.nicknameCheckGameCode) withNickname += 1;
      if (d.supplierSku) {
        withSku += 1;
        expect(d.autoDeliverySource).toBe("digiflazz");
        expect(d.supplierSku.toLowerCase()).not.toContain("fixture");
      }
    }
    expect(withNickname).toBeGreaterThan(50);
    expect(withSku).toBeGreaterThan(20);
    expect(nearCap).toBeGreaterThanOrEqual(2);
    for (const p of products) {
      const packs = p.denominations.filter((d) => d.qtyValue != null).sort((a, b) => a.sortOrder - b.sortOrder);
      for (let i = 1; i < packs.length; i += 1) expect(Number(packs[i]!.price)).toBeGreaterThan(Number(packs[i - 1]!.price));
    }

    // No credentials anywhere.
    expect(await db.prisma.setting.count({ where: { key: { contains: "api_key" } } })).toBe(0);
  }, 120_000);

  it("shares Premium Apps with the small fixture without duplicating it", async () => {
    await buildGameTopupFixtures(db.prisma);
    const names = (await db.prisma.category.findMany({ select: { name: true } })).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((x) => x === "Premium Apps")).toHaveLength(1);
  }, 120_000);

  it("can seed just some games (used by the end-to-end test) without the Premium Apps", async () => {
    await db.prisma.denomination.deleteMany();
    await db.prisma.product.deleteMany();
    await db.prisma.category.deleteMany();
    const some = await buildBulkGameTopupCatalog(db.prisma, { games: ["Mobile Legends"] });
    expect(some.gameCategories).toBe(1);
    expect(some.premiumProducts).toBe(0);
    expect(await db.prisma.category.count()).toBe(1);
    expect(await db.prisma.product.count()).toBe(4);
  }, 60_000);

  it("shows no seed marker anywhere, adopts its manifest rows on a second run and refuses an unmanifested namesake", async () => {
    await buildBulkGameTopupCatalog(db.prisma);
    await expectNoVisibleMarkers(db.prisma);

    // Fresh database: manifest-mode run twice gives the same ids and the documented totals.
    await db.prisma.denomination.deleteMany();
    await db.prisma.product.deleteMany();
    await db.prisma.category.deleteMany();
    await db.prisma.user.deleteMany();
    const manifest = new SeedManifest();
    const first = await buildBulkGameTopupCatalog(db.prisma, { manifest });
    const total = await counts();
    expect(total).toEqual(EXPECTED_TOTAL);
    const again = await buildBulkGameTopupCatalog(db.prisma, { manifest });
    expect(again).toEqual(first);
    expect(await counts()).toEqual(total);
    await expectNoVisibleMarkers(db.prisma);

    // A shop product with the same name in a seed category is refused, not taken over.
    const valorantCat = await db.prisma.category.findUniqueOrThrow({ where: { name: "Valorant" } });
    const valorant = await db.prisma.product.findFirstOrThrow({ where: { categoryId: valorantCat.id, gameRegion: { contains: "Singapore" } } });
    await db.prisma.denomination.deleteMany({ where: { productId: valorant.id } });
    await db.prisma.product.delete({ where: { id: valorant.id } });
    manifest.delete("products", valorant.id);
    await db.prisma.product.create({ data: { categoryId: valorantCat.id, name: "Valorant", slug: "valorant-shop-own", gameRegion: valorant.gameRegion } });
    await expect(buildBulkGameTopupCatalog(db.prisma, { manifest })).rejects.toThrow(/"Valorant"/);
  }, 180_000);
});
