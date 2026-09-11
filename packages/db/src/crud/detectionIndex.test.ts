import { describe, it, expect, vi, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { createCategory, createCatalogProduct } from "./catalog";
import {
  getCatalogIndex,
  bumpCatalogRevision,
  __clearDetectionIndexCacheForTests,
} from "./detectionIndex";
import {
  __clearDetectionKnowledgeCacheForTests,
  upsertDetectionToken,
} from "./detectionKnowledge";
import { normalize } from "@app/core/detection";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma); // clears the detection_* tables too
  __clearDetectionIndexCacheForTests(prisma);
  __clearDetectionKnowledgeCacheForTests(prisma);
});
afterEach(() => {
  vi.useRealTimers();
});

async function makeCategory() {
  return createCategory(prisma, `Games ${Math.random()}`, "🎮");
}

/** Create a Product; `digiflazzBrand` non-null makes it a catalog row. */
async function makeProduct(categoryId: number, name: string, digiflazzBrand: string | null) {
  return createCatalogProduct(prisma, { categoryId, name, digiflazzBrand });
}

/** Insert a catalog-row Product straight through the Prisma client, bypassing
 * createCatalogProduct entirely. Lands a row in the DB with NO revision bump
 * unconditionally — the honest way to exercise the index cache's TTL-only
 * staleness path regardless of whether createCatalogProduct itself bumps
 * (Task 10: currently it deliberately does not, see its own doc comment). */
async function rawCatalogRow(categoryId: number, name: string, digiflazzBrand: string) {
  const slug = `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(36).slice(2, 8)}`;
  return prisma.product.create({ data: { categoryId, name, slug, digiflazzBrand } });
}

describe("getCatalogIndex", () => {
  it("reflects every Product that has a non-null digiflazzBrand", async () => {
    const category = await makeCategory();
    await makeProduct(category.id, "Mobile Legends", "MOBILE LEGENDS");
    await makeProduct(category.id, "Free Fire", "FREE FIRE");

    const index = await getCatalogIndex(prisma);

    expect(index.entryCount).toBe(2);
    expect(index.byNormalizedName.has(normalize("Mobile Legends"))).toBe(true);
    expect(index.byNormalizedName.has(normalize("Free Fire"))).toBe(true);
  });

  it("excludes Products whose digiflazzBrand is null (hand-created, not from a supplier import)", async () => {
    const category = await makeCategory();
    await makeProduct(category.id, "Imported Product", "IMPORTED BRAND");
    await makeProduct(category.id, "Hand Made Product", null);

    const index = await getCatalogIndex(prisma);

    expect(index.entryCount).toBe(1);
    expect(index.byNormalizedName.has(normalize("Imported Product"))).toBe(true);
    expect(index.byNormalizedName.has(normalize("Hand Made Product"))).toBe(false);
  });

  it("maps each entry's refId to the Product's own id", async () => {
    const category = await makeCategory();
    const product = await makeProduct(category.id, "Genshin Impact", "GENSHIN IMPACT");

    const index = await getCatalogIndex(prisma);
    const bucket = index.byNormalizedName.get(normalize("Genshin Impact"));

    expect(bucket).toHaveLength(1);
    expect(bucket?.[0]).toMatchObject({
      externalId: null,
      productName: "Genshin Impact",
      category: null,
      type: null,
      refId: String(product.id),
    });
  });

  it("serves a cached value within the TTL, even after a catalog row is added underneath it", async () => {
    const category = await makeCategory();
    // Raw prisma.product.create so the rows land with NO catalog-revision
    // bump, unconditionally — this test is about TTL-only staleness.
    await rawCatalogRow(category.id, "First Product", "FIRST");
    const first = await getCatalogIndex(prisma);
    expect(first.entryCount).toBe(1);

    // Add a row WITHOUT bumping the catalog revision — the cache should not
    // notice it until the TTL lapses or the revision is bumped.
    await rawCatalogRow(category.id, "Second Product", "SECOND");

    const second = await getCatalogIndex(prisma);
    expect(second.entryCount).toBe(1);
  });

  it("rebuilds once the 30s TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const category = await makeCategory();
    // Raw prisma.product.create so neither row bumps the catalog revision —
    // the rebuild below must be driven purely by the 30s TTL lapsing.
    await rawCatalogRow(category.id, "First Product", "FIRST");
    await getCatalogIndex(prisma);

    await rawCatalogRow(category.id, "Second Product", "SECOND");
    vi.setSystemTime(31_000); // past the 30s TTL

    const afterTtl = await getCatalogIndex(prisma);
    expect(afterTtl.entryCount).toBe(2);
  });

  it("rebuilds immediately when bumpCatalogRevision is called, without waiting for the TTL", async () => {
    const category = await makeCategory();
    await makeProduct(category.id, "First Product", "FIRST");
    await getCatalogIndex(prisma); // primes the cache

    await makeProduct(category.id, "Second Product", "SECOND");
    await bumpCatalogRevision(prisma);

    const afterBump = await getCatalogIndex(prisma);
    expect(afterBump.entryCount).toBe(2);
  });

  it("__clearDetectionIndexCacheForTests invalidates the cache immediately", async () => {
    const category = await makeCategory();
    await makeProduct(category.id, "First Product", "FIRST");
    await getCatalogIndex(prisma); // primes the cache

    await makeProduct(category.id, "Second Product", "SECOND");
    __clearDetectionIndexCacheForTests(prisma);

    const afterClear = await getCatalogIndex(prisma);
    expect(afterClear.entryCount).toBe(2);
  });

  it("invalidates the cached index when a knowledge-token edit bumps only the knowledge revision (not the catalog revision)", async () => {
    const category = await makeCategory();
    // "turbo" is not a known token yet, so it classifies as a core token and
    // is baked into this product's base/product key.
    await makeProduct(category.id, "Zeta Quest Turbo", "ZETA QUEST TURBO");

    const before = await getCatalogIndex(prisma);
    const beforeProductKeys = [...before.byProductKey.keys()].sort();
    expect(before.byNormalizedName.has(normalize("Zeta Quest Turbo"))).toBe(true);

    // Promote "turbo" to a product-defining edition token. This bumps
    // detection_knowledge_revision but NOT detection_catalog_revision, and
    // does not touch any Product row — so without folding the knowledge
    // revision into the index cache key, getCatalogIndex would keep serving
    // the pre-edit index until the 30s TTL lapsed.
    await upsertDetectionToken(
      prisma,
      { category: "edition", token: "turbo", canonical: "turbo", isProductDefining: true },
      null,
    );

    const after = await getCatalogIndex(prisma);

    // The rebuilt index reflects the new knowledge: the stamp advanced with
    // the knowledge revision, and "turbo" now splits into a defining token so
    // the product's key changed.
    expect(after.stamp).not.toBe(before.stamp);
    const afterProductKeys = [...after.byProductKey.keys()].sort();
    expect(afterProductKeys).not.toEqual(beforeProductKeys);
  });
});

describe("bumpCatalogRevision", () => {
  it("creates then monotonically increments the detection_catalog_revision setting", async () => {
    const before = await prisma.setting.findUnique({ where: { key: "detection_catalog_revision" } });
    expect(before).toBeNull();

    await bumpCatalogRevision(prisma);
    const afterOne = await prisma.setting.findUnique({ where: { key: "detection_catalog_revision" } });
    expect(afterOne?.value).toBe("1");

    await bumpCatalogRevision(prisma);
    const afterTwo = await prisma.setting.findUnique({ where: { key: "detection_catalog_revision" } });
    expect(afterTwo?.value).toBe("2");
  });
});
