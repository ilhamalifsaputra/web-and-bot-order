import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceForCategoryGroup } from "@app/core/services";
import { CategoryGroup } from "@app/core/enums";
import { MAX_LABEL_WIDTH, MAX_LABEL_BYTES, visualWidth } from "@app/core/buttonLimits";
import { makeTestDb, type TestDb } from "./testdb";
import { buildBulkGameTopupCatalog, BULK_REGIONAL_GAMES } from "./gameTopupBulkCatalog";
import { buildGameTopupFixtures } from "./gameTopupFixtures";

let db: TestDb;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db.cleanup(); });

const TAG = " [SEED-GTR]";
const counts = async () => ({
  categories: await db.prisma.category.count(),
  products: await db.prisma.product.count(),
  denominations: await db.prisma.denomination.count(),
});

describe("buildBulkGameTopupCatalog", () => {
  it("builds a large catalog that is valid, separated by family and idempotent", async () => {
    const first = await buildBulkGameTopupCatalog(db.prisma, { tag: TAG });
    const afterFirst = await counts();
    expect(first.games).toBeGreaterThanOrEqual(30);
    expect(first.products).toBeGreaterThanOrEqual(60);
    expect(first.denominations).toBeGreaterThanOrEqual(600);
    expect(first.premiumProducts).toBe(8);
    expect(first.regions).toBeGreaterThan(20);
    expect(afterFirst.products).toBe(first.products);
    expect(afterFirst.denominations).toBe(first.denominations);

    const second = await buildBulkGameTopupCatalog(db.prisma, { tag: TAG });
    expect(await counts()).toEqual(afterFirst);
    expect(second).toEqual(first);

    // Family comes from the category group, never from names.
    const products = await db.prisma.product.findMany({ include: { category: true, denominations: true } });
    for (const p of products) {
      expect(p.name.endsWith(TAG)).toBe(true);
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

    // Region categories: every product has a region; the edition category also a variant.
    const regionalCat = products.filter((p) => p.categoryId === first.categories.regional);
    expect(regionalCat.length).toBeGreaterThan(25);
    expect(regionalCat.every((p) => p.gameRegion && !p.gameVariant)).toBe(true);
    const mlRegions = regionalCat.filter((p) => p.name === `Mobile Legends${TAG}`).map((p) => p.gameRegion).sort();
    expect(mlRegions).toEqual(["Global", "Indonesia", "Malaysia", "Philippines"]);
    const editionCat = products.filter((p) => p.categoryId === first.categories.editions);
    expect(editionCat.length).toBeGreaterThanOrEqual(8);
    expect(editionCat.every((p) => p.gameRegion && p.gameVariant)).toBe(true);
    const plainCat = products.filter((p) => p.categoryId === first.categories.gameTopUp);
    expect(plainCat.length).toBeGreaterThanOrEqual(15);
    expect(plainCat.every((p) => !p.gameRegion && !p.gameVariant)).toBe(true);
    expect(BULK_REGIONAL_GAMES.length).toBeGreaterThanOrEqual(12);

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
      expect(d.name.endsWith(TAG)).toBe(true);
      const bare = d.name.slice(0, -TAG.length);
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
        expect(d.supplierSku.startsWith("fixture-")).toBe(true);
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

  it("shares categories with the small fixture without duplicating them", async () => {
    await buildGameTopupFixtures(db.prisma, { tag: TAG });
    const names = (await db.prisma.category.findMany({ select: { name: true } })).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((x) => x === `Game Top Up${TAG}`)).toHaveLength(1);
    expect(names.filter((x) => x === `Premium Apps${TAG}`)).toHaveLength(1);
  }, 120_000);
});
