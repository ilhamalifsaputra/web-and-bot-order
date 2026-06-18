import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  createGroup,
  deleteGroup,
  assignProductToGroup,
  listCatalogEntries,
  listNewestCatalogEntries,
  searchCatalogEntries,
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

async function makeCategory() {
  return prisma.category.create({ data: { name: `c${Math.random()}` } });
}
async function makeProduct(categoryId: number, name: string, duration: string, price: string) {
  return prisma.product.create({
    data: { categoryId, name, type: "SHARED", durationLabel: duration, price },
  });
}

describe("assignProductToGroup", () => {
  it("links a product whose category matches the group", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Capcut" });
    const p = await makeProduct(cat.id, "Capcut 1 Month", "1 Month", "5");
    await assignProductToGroup(prisma, p.id, group.id);
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh!.productGroupId).toBe(group.id);
  });

  it("rejects a product from a different category", async () => {
    const catA = await makeCategory();
    const catB = await makeCategory();
    const group = await createGroup(prisma, { categoryId: catA.id, name: "G" });
    const p = await makeProduct(catB.id, "X", "1 Month", "5");
    await expect(assignProductToGroup(prisma, p.id, group.id)).rejects.toBeInstanceOf(
      CategoryMismatchError,
    );
  });

  it("unlinks when groupId is null", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "G2" });
    const p = await makeProduct(cat.id, "Y", "1 Month", "5");
    await assignProductToGroup(prisma, p.id, group.id);
    await assignProductToGroup(prisma, p.id, null);
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh!.productGroupId).toBeNull();
  });
});

describe("deleteGroup", () => {
  it("unlinks members but keeps the products", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "G3" });
    const p = await makeProduct(cat.id, "Z", "1 Month", "5");
    await assignProductToGroup(prisma, p.id, group.id);
    await deleteGroup(prisma, group.id);
    expect(await prisma.productGroup.findUnique({ where: { id: group.id } })).toBeNull();
    const fresh = await prisma.product.findUnique({ where: { id: p.id } });
    expect(fresh).not.toBeNull();
    expect(fresh!.productGroupId).toBeNull();
  });
});

describe("listCatalogEntries", () => {
  it("emits a group with >=2 active members, sorted by member price asc", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Capcut" });
    const month = await makeProduct(cat.id, "Capcut 1 Month", "1 Month", "30");
    const week = await makeProduct(cat.id, "Capcut 7 day", "7 day", "10");
    await assignProductToGroup(prisma, month.id, group.id);
    await assignProductToGroup(prisma, week.id, group.id);

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.kind).toBe("group");
    if (e.kind !== "group") throw new Error("unreachable");
    expect(e.group.name).toBe("Capcut");
    expect(e.members.map((m) => m.id)).toEqual([week.id, month.id]); // 10 before 30
  });

  it("collapses a single-active-member group to a product entry", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Solo" });
    const only = await makeProduct(cat.id, "Solo 1 Month", "1 Month", "5");
    await assignProductToGroup(prisma, only.id, group.id);

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("product");
  });

  it("hides empty/inactive groups and lists ungrouped active products", async () => {
    const cat = await makeCategory();
    const empty = await createGroup(prisma, { categoryId: cat.id, name: "Empty" });
    expect(empty).toBeTruthy();
    const loose = await makeProduct(cat.id, "Loose", "1 Month", "5");
    void loose;

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries.map((e) => e.kind)).toEqual(["product"]); // empty group hidden, loose product shown
  });

  it("treats members of an inactive group as ungrouped (flat fallback)", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Off" });
    const a = await makeProduct(cat.id, "Off A", "1 Month", "5");
    const b = await makeProduct(cat.id, "Off B", "7 day", "3");
    await assignProductToGroup(prisma, a.id, group.id);
    await assignProductToGroup(prisma, b.id, group.id);
    await prisma.productGroup.update({ where: { id: group.id }, data: { isActive: false } });

    const entries = await listCatalogEntries(prisma, cat.id);
    expect(entries.every((e) => e.kind === "product")).toBe(true);
    expect(entries).toHaveLength(2);
  });
});

describe("listNewestCatalogEntries", () => {
  it("ranks a group by its newest active member, above an older loose product", async () => {
    const cat = await makeCategory();
    const old = await makeProduct(cat.id, "Older Loose", "1 Month", "5");
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Capcut" });
    const wk = await makeProduct(cat.id, "Capcut 7 day", "7 day", "10");
    const mo = await makeProduct(cat.id, "Capcut 1 Month", "1 Month", "30");
    await assignProductToGroup(prisma, wk.id, group.id);
    await assignProductToGroup(prisma, mo.id, group.id);

    const entries = await listNewestCatalogEntries(prisma, 50);
    const groupIdx = entries.findIndex((e) => e.kind === "group" && e.group.id === group.id);
    const looseIdx = entries.findIndex((e) => e.kind === "product" && e.product.id === old.id);
    expect(groupIdx).toBeGreaterThanOrEqual(0);
    expect(looseIdx).toBeGreaterThanOrEqual(0);
    expect(groupIdx).toBeLessThan(looseIdx); // group (newer member) ranks first
  });

  it("collapses a single-member group and honours the limit", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "Solo" });
    const only = await makeProduct(cat.id, "Solo 1 Month", "1 Month", "5");
    await assignProductToGroup(prisma, only.id, group.id);

    const entries = await listNewestCatalogEntries(prisma, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("product"); // newest row is the just-created Solo product
  });
});

describe("searchCatalogEntries", () => {
  it("collapses a grouped denomination match into a group card", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "ZorroBrand" });
    const a = await makeProduct(cat.id, "ZorroBrand 1 Month", "1 Month", "30");
    const b = await makeProduct(cat.id, "ZorroBrand 7 day", "7 day", "10");
    await assignProductToGroup(prisma, a.id, group.id);
    await assignProductToGroup(prisma, b.id, group.id);

    const entries = await searchCatalogEntries(prisma, "ZorroBrand", 24);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("group");
    if (entries[0]!.kind !== "group") throw new Error("unreachable");
    expect(entries[0]!.group.id).toBe(group.id);
    expect(entries[0]!.members).toHaveLength(2);
  });

  it("keeps an ungrouped match as a product card", async () => {
    const cat = await makeCategory();
    const loose = await makeProduct(cat.id, "LonelyUnique", "1 Month", "5");
    const entries = await searchCatalogEntries(prisma, "LonelyUnique", 24);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.kind).toBe("product");
    if (entries[0]!.kind !== "product") throw new Error("unreachable");
    expect(entries[0]!.product.id).toBe(loose.id);
  });

  it("matches a group by its name even when members don't match the query", async () => {
    const cat = await makeCategory();
    const group = await createGroup(prisma, { categoryId: cat.id, name: "QuokkaPack" });
    const a = await makeProduct(cat.id, "QuokkaBasic", "1 Month", "30");
    const b = await makeProduct(cat.id, "QuokkaPro", "7 day", "10");
    await assignProductToGroup(prisma, a.id, group.id);
    await assignProductToGroup(prisma, b.id, group.id);

    const entries = await searchCatalogEntries(prisma, "QuokkaPack", 24);
    expect(entries.some((e) => e.kind === "group" && e.group.id === group.id)).toBe(true);
  });

  it("returns [] for an empty query", async () => {
    expect(await searchCatalogEntries(prisma, "   ", 24)).toEqual([]);
  });

  it("caps unbounded matches to the name-sorted top `limit` (P5-01 parity)", async () => {
    // 120 matches > the DB over-fetch cap (limit * SEARCH_OVERFETCH = 96). The
    // result must still be the alphabetically-first 24 cards, proving the take
    // can't drop a card that belongs in the name-sorted top `limit`.
    const cat = await makeCategory();
    const expectedTop = Array.from({ length: 24 }, (_, i) => `ItemCap ${String(i + 1).padStart(3, "0")}`);
    await prisma.product.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        categoryId: cat.id,
        name: `ItemCap ${String(i + 1).padStart(3, "0")}`,
        type: "SHARED" as const,
        durationLabel: "1 Month",
        price: "5",
      })),
    });

    const entries = await searchCatalogEntries(prisma, "ItemCap", 24);
    expect(entries).toHaveLength(24);
    expect(entries.every((e) => e.kind === "product")).toBe(true);
    const names = entries.map((e) => (e.kind === "group" ? e.group.name : e.product.name));
    expect(names).toEqual(expectedTop);
  });
});
