import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  slugify,
  ensureUniqueSlug,
  createCategory,
  createCatalogProduct,
  createDenomination,
  getCatalogProductWithDenominations,
  getDenominationWithProduct,
  assignDenominationToProduct,
  deleteCatalogProduct,
  deleteCatalogProductCascade,
  listCatalogProducts,
  listNewestCatalogProducts,
  searchCatalog,
  CategoryMismatchError,
} from "./catalog";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

async function makeCategory(name = `c${Math.random()}`) {
  return createCategory(prisma, name);
}
async function makeProduct(categoryId: number, name: string) {
  return createCatalogProduct(prisma, { categoryId, name });
}
async function makeDenom(productId: number, name: string, price: string, duration = "1 Month") {
  return createDenomination(prisma, { productId, name, type: "SHARED", durationLabel: duration, price });
}

describe("slugify", () => {
  it("lowercases, strips punctuation, hyphenates and trims", () => {
    expect(slugify("CapCut Pro!!")).toBe("capcut-pro");
    expect(slugify("  Hello   World  ")).toBe("hello-world");
    expect(slugify("Café Déjà")).toBe("cafe-deja");
    expect(slugify("***")).toBe("item"); // empty → fallback
  });
});

describe("ensureUniqueSlug", () => {
  it("dedupes collisions with a numeric suffix", async () => {
    const cat = await makeCategory("Dup Cat");
    expect(cat.slug).toBe("dup-cat");
    const next = await ensureUniqueSlug(prisma, "category", "Dup Cat");
    expect(next).toBe("dup-cat-2");
  });

  it("auto-generates unique slugs across products of the same name", async () => {
    const cat = await makeCategory();
    const a = await makeProduct(cat.id, "Same Name");
    const b = await makeProduct(cat.id, "Same Name");
    expect(a.slug).toBe("same-name");
    expect(b.slug).toBe("same-name-2");
  });
});

describe("assignDenominationToProduct", () => {
  it("moves a denomination to a product in the same category", async () => {
    const cat = await makeCategory();
    const p1 = await makeProduct(cat.id, "P1");
    const p2 = await makeProduct(cat.id, "P2");
    const d = await makeDenom(p1.id, "1 Month", "5");
    await assignDenominationToProduct(prisma, d.id, p2.id);
    const fresh = await prisma.denomination.findUnique({ where: { id: d.id } });
    expect(fresh!.productId).toBe(p2.id);
  });

  it("rejects a move across categories", async () => {
    const catA = await makeCategory();
    const catB = await makeCategory();
    const pA = await makeProduct(catA.id, "A");
    const pB = await makeProduct(catB.id, "B");
    const d = await makeDenom(pA.id, "1 Month", "5");
    await expect(assignDenominationToProduct(prisma, d.id, pB.id)).rejects.toBeInstanceOf(
      CategoryMismatchError,
    );
  });
});

describe("delete product", () => {
  it("refuses to delete a product that still has denominations", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Full");
    await makeDenom(p.id, "1 Month", "5");
    await expect(deleteCatalogProduct(prisma, p.id)).rejects.toThrow(/not empty/);
  });

  it("deletes an empty product", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Empty");
    await deleteCatalogProduct(prisma, p.id);
    expect(await prisma.product.findUnique({ where: { id: p.id } })).toBeNull();
  });

  it("cascade deletes a product and its denominations", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Casc");
    const d = await makeDenom(p.id, "1 Month", "5");
    await deleteCatalogProductCascade(prisma, p.id);
    expect(await prisma.product.findUnique({ where: { id: p.id } })).toBeNull();
    expect(await prisma.denomination.findUnique({ where: { id: d.id } })).toBeNull();
  });
});

describe("getCatalogProductWithDenominations / getDenominationWithProduct", () => {
  it("loads a product with denominations price-asc + category", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "CapCut Pro");
    const mo = await makeDenom(p.id, "1 Month", "30");
    const wk = await makeDenom(p.id, "1 Week", "10");
    const got = await getCatalogProductWithDenominations(prisma, p.id);
    expect(got!.category.id).toBe(cat.id);
    expect(got!.denominations.map((d) => d.id)).toEqual([wk.id, mo.id]); // 10 before 30
  });

  it("loads a denomination with its parent product + category", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Parent");
    const d = await makeDenom(p.id, "1 Month", "5");
    const got = await getDenominationWithProduct(prisma, d.id);
    expect(got!.product.id).toBe(p.id);
    expect(got!.product.category.id).toBe(cat.id);
  });
});

describe("listCatalogProducts", () => {
  it("returns active products with ≥1 active denomination, denominations price-asc", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Shown");
    await makeDenom(p.id, "1 Month", "30");
    await makeDenom(p.id, "1 Week", "10");
    // a product with no denominations must NOT appear
    await makeProduct(cat.id, "Hidden Empty");

    const list = await listCatalogProducts(prisma, cat.id);
    const shown = list.find((x) => x.id === p.id);
    expect(shown).toBeTruthy();
    expect(shown!.denominations.map((d) => d.price.toString())).toEqual(["10", "30"]);
    expect(list.some((x) => x.name === "Hidden Empty")).toBe(false);
  });

  it("excludes products whose only denomination is inactive", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "OnlyInactive");
    const d = await makeDenom(p.id, "1 Month", "5");
    await prisma.denomination.update({ where: { id: d.id }, data: { isActive: false } });
    const list = await listCatalogProducts(prisma, cat.id);
    expect(list.some((x) => x.id === p.id)).toBe(false);
  });
});

describe("searchCatalog", () => {
  it("matches products by name (not denominations) and returns [] for blank", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "ZorroBrand Studio");
    await makeDenom(p.id, "Basic Plan", "10");
    const hits = await searchCatalog(prisma, "ZorroBrand", 24);
    expect(hits.some((x) => x.id === p.id)).toBe(true);
    // a query that only matches the denomination name should NOT surface the product
    expect((await searchCatalog(prisma, "Basic Plan", 24)).some((x) => x.id === p.id)).toBe(false);
    expect(await searchCatalog(prisma, "   ", 24)).toEqual([]);
  });
});

describe("listNewestCatalogProducts", () => {
  it("honours the limit and only returns products with active denominations", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Newest");
    await makeDenom(p.id, "1 Month", "5");
    const list = await listNewestCatalogProducts(prisma, 1);
    expect(list).toHaveLength(1);
    expect(list[0]!.denominations.length).toBeGreaterThanOrEqual(1);
  });
});
