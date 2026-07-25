import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { createOrderDirect } from "./orders";
import { upsertUser } from "./users";
import { bulkAddStock } from "./stock";
import {
  slugify,
  ensureUniqueSlug,
  createCategory,
  createCatalogProduct,
  createDenomination,
  getCatalogProduct,
  updateCatalogProduct,
  getCatalogProductWithDenominations,
  getDenominationWithProduct,
  assignDenominationToProduct,
  deleteCatalogProduct,
  deleteCatalogProductCascade,
  deleteDenomination,
  bulkSetCatalogProductsActive,
  setCatalogProductArchived,
  bulkSetCatalogProductsArchived,
  listProducts,
  listCatalogProducts,
  listNewestCatalogProducts,
  listFlashSaleProducts,
  hasActiveFlashSale,
  searchCatalog,
  searchDenominations,
  lowStockDenominations,
  setFlashSale,
  clearFlashSale,
  listUnannouncedStartedFlashSales,
  listDenominationsWithFlashInfo,
  bulkSetFlashSale,
  bulkClearFlashSale,
  flashSalePerformance,
  CategoryMismatchError,
} from "./catalog";
import { ValidationError } from "@app/core/errors";
import { Decimal } from "@app/core/money";

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

describe("createDenomination — deliveryType/additionalFields", () => {
  it("defaults deliveryType to \"auto\" and additionalFields to null when omitted", async () => {
    const cat = await makeCategory();
    const product = await makeProduct(cat.id, "Defaults");
    const denom = await makeDenom(product.id, "1 Month", "10000");
    expect(denom.deliveryType).toBe("auto");
    expect(denom.additionalFields).toBeNull();
  });

  it("persists an explicit deliveryType and additionalFields JSON string", async () => {
    const cat = await makeCategory();
    const product = await makeProduct(cat.id, "Explicit");
    const fieldsJson = JSON.stringify([
      { key: "ign", label: { id: "IGN", en: "IGN" }, type: "text", required: true, options: [], placeholder: "" },
    ]);
    const denom = await createDenomination(prisma, {
      productId: product.id,
      name: "1 Month",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual_with_info",
      additionalFields: fieldsJson,
    });
    expect(denom.deliveryType).toBe("manual_with_info");
    expect(denom.additionalFields).toBe(fieldsJson);
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

describe("deleteDenomination", () => {
  it("deletes a denomination with no order history", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Deletable");
    const d = await makeDenom(p.id, "1 Month", "5");
    await deleteDenomination(prisma, d.id);
    expect(await prisma.denomination.findUnique({ where: { id: d.id } })).toBeNull();
  });

  it("refuses to delete a denomination with order history", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Ordered");
    const d = await makeDenom(p.id, "1 Month", "5");
    await bulkAddStock(prisma, d.id, ["cred1"]);
    const user = await upsertUser(prisma, {
      telegramId: Math.floor(Math.random() * 1_000_000_000),
      username: null,
      fullName: null,
    });
    await createOrderDirect(prisma, { user, productId: d.id, quantity: 1 });
    await expect(deleteDenomination(prisma, d.id)).rejects.toThrow(/order history/);
    expect(await prisma.denomination.findUnique({ where: { id: d.id } })).not.toBeNull();
  });
});

describe("bulkSetCatalogProductsActive", () => {
  it("flips isActive on the given products only, returns the updated count", async () => {
    const cat = await makeCategory();
    const a = await makeProduct(cat.id, "A");
    const b = await makeProduct(cat.id, "B");
    const c = await makeProduct(cat.id, "C");

    const count = await bulkSetCatalogProductsActive(prisma, [a.id, b.id], false);
    expect(count).toBe(2);
    expect((await prisma.product.findUnique({ where: { id: a.id } }))!.isActive).toBe(false);
    expect((await prisma.product.findUnique({ where: { id: b.id } }))!.isActive).toBe(false);
    expect((await prisma.product.findUnique({ where: { id: c.id } }))!.isActive).toBe(true);
  });

  it("returns 0 for an empty id list", async () => {
    expect(await bulkSetCatalogProductsActive(prisma, [], true)).toBe(0);
  });
});

describe("setCatalogProductArchived", () => {
  it("flips isArchived on the given product only", async () => {
    const cat = await makeCategory();
    const a = await makeProduct(cat.id, "A");
    const b = await makeProduct(cat.id, "B");

    await setCatalogProductArchived(prisma, a.id, true);
    expect((await prisma.product.findUnique({ where: { id: a.id } }))!.isArchived).toBe(true);
    expect((await prisma.product.findUnique({ where: { id: b.id } }))!.isArchived).toBe(false);

    await setCatalogProductArchived(prisma, a.id, false);
    expect((await prisma.product.findUnique({ where: { id: a.id } }))!.isArchived).toBe(false);
  });
});

describe("bulkSetCatalogProductsArchived", () => {
  it("flips isArchived on the given products only, returns the updated count", async () => {
    const cat = await makeCategory();
    const a = await makeProduct(cat.id, "A");
    const b = await makeProduct(cat.id, "B");
    const c = await makeProduct(cat.id, "C");

    const count = await bulkSetCatalogProductsArchived(prisma, [a.id, b.id], true);
    expect(count).toBe(2);
    expect((await prisma.product.findUnique({ where: { id: a.id } }))!.isArchived).toBe(true);
    expect((await prisma.product.findUnique({ where: { id: b.id } }))!.isArchived).toBe(true);
    expect((await prisma.product.findUnique({ where: { id: c.id } }))!.isArchived).toBe(false);
  });

  it("returns 0 for an empty id list", async () => {
    expect(await bulkSetCatalogProductsArchived(prisma, [], true)).toBe(0);
  });
});

describe("listProducts — archived filtering", () => {
  it("defaults to excluding archived products", async () => {
    const cat = await makeCategory();
    const shown = await makeProduct(cat.id, "Shown");
    const archived = await makeProduct(cat.id, "Archived");
    await setCatalogProductArchived(prisma, archived.id, true);

    const list = await listProducts(prisma, cat.id);
    expect(list.some((p) => p.id === shown.id)).toBe(true);
    expect(list.some((p) => p.id === archived.id)).toBe(false);
  });

  it('"only" returns just the archived products', async () => {
    const cat = await makeCategory();
    const shown = await makeProduct(cat.id, "Shown");
    const archived = await makeProduct(cat.id, "Archived");
    await setCatalogProductArchived(prisma, archived.id, true);

    const list = await listProducts(prisma, cat.id, "only");
    expect(list.some((p) => p.id === archived.id)).toBe(true);
    expect(list.some((p) => p.id === shown.id)).toBe(false);
  });

  it('"all" returns both archived and non-archived products', async () => {
    const cat = await makeCategory();
    const shown = await makeProduct(cat.id, "Shown");
    const archived = await makeProduct(cat.id, "Archived");
    await setCatalogProductArchived(prisma, archived.id, true);

    const list = await listProducts(prisma, cat.id, "all");
    expect(list.some((p) => p.id === shown.id)).toBe(true);
    expect(list.some((p) => p.id === archived.id)).toBe(true);
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

describe("storefront detail blocks (whatYouGet / terms / warrantyNote)", () => {
  it("defaults all three to null so products predating the columns stay valid", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "No Details");
    expect(p.whatYouGet).toBeNull();
    expect(p.terms).toBeNull();
    expect(p.warrantyNote).toBeNull();
  });

  it("round-trips the three blocks through create and update", async () => {
    const cat = await makeCategory();
    const p = await createCatalogProduct(prisma, {
      categoryId: cat.id,
      name: "With Details",
      whatYouGet: "Private account, 1 device",
      terms: "Don't change the email.",
      warrantyNote: "30 days.",
    });
    expect(p.whatYouGet).toBe("Private account, 1 device");
    expect(p.terms).toBe("Don't change the email.");

    await updateCatalogProduct(prisma, p.id, { warrantyNote: null, terms: "New terms." });
    const after = await getCatalogProduct(prisma, p.id);
    // Clearing a block must actually clear it — the product page decides
    // whether to render a heading from exactly this null.
    expect(after!.warrantyNote).toBeNull();
    expect(after!.terms).toBe("New terms.");
    expect(after!.whatYouGet).toBe("Private account, 1 device");
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

  it("excludes an archived product even when active with active denominations", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Archived");
    await makeDenom(p.id, "1 Month", "5");
    await setCatalogProductArchived(prisma, p.id, true);
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

describe("searchDenominations", () => {
  it("includes the parent product so callers can render a product sublabel", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Steam Wallet");
    const denom = await makeDenom(p.id, "50k", "50000");
    const hits = await searchDenominations(prisma, "50k", 20);
    const hit = hits.find((x) => x.id === denom.id);
    expect(hit).toBeDefined();
    expect(hit!.product?.name).toBe("Steam Wallet");
  });

  it("returns [] for a blank query", async () => {
    expect(await searchDenominations(prisma, "   ", 20)).toEqual([]);
  });
});

describe("lowStockDenominations", () => {
  it("excludes manual/manual_with_info SKUs even though they always read available: 0", async () => {
    const cat = await makeCategory();
    const product = await makeProduct(cat.id, "Low Stock Mix");

    const autoDenom = await makeDenom(product.id, "Auto Low", "10000");
    await bulkAddStock(prisma, autoDenom.id, ["cred-1", "cred-2"]); // 2 available, at/below threshold

    const manualDenom = await createDenomination(prisma, {
      productId: product.id,
      name: "Manual No Stock",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual",
    });
    const manualWithInfoDenom = await createDenomination(prisma, {
      productId: product.id,
      name: "Manual With Info No Stock",
      type: "SHARED",
      durationLabel: "1 Month",
      price: "10000",
      deliveryType: "manual_with_info",
    });

    const results = await lowStockDenominations(prisma, 5);
    const ids = results.map((r) => r.denomination.id);
    expect(ids).toContain(autoDenom.id);
    expect(ids).not.toContain(manualDenom.id);
    expect(ids).not.toContain(manualWithInfoDenom.id);
  });
});

describe("flash sales", () => {
  const HOUR = 3_600_000;
  const inHours = (h: number) => new Date(Date.now() + h * HOUR);

  describe("setFlashSale", () => {
    it("stores the percent and window on the denomination", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Happy");
      const d = await makeDenom(p.id, "1 Month", "10000");

      const startsAt = inHours(1);
      const endsAt = inHours(5);
      await setFlashSale(prisma, { denominationId: d.id, discountPercent: "30", startsAt, endsAt });

      const fresh = await prisma.denomination.findUnique({ where: { id: d.id } });
      expect(Number(fresh!.flashDiscountPercent)).toBe(30);
      expect(fresh!.flashStartsAt!.getTime()).toBe(startsAt.getTime());
      expect(fresh!.flashEndsAt!.getTime()).toBe(endsAt.getTime());
      expect(fresh!.flashAnnouncedAt).toBeNull();
    });

    it("accepts a window that has already started but not yet ended", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Running");
      const d = await makeDenom(p.id, "1 Month", "10000");
      await setFlashSale(prisma, {
        denominationId: d.id,
        discountPercent: "10",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });
      const fresh = await prisma.denomination.findUnique({ where: { id: d.id } });
      expect(Number(fresh!.flashDiscountPercent)).toBe(10);
    });

    it("rejects a discount percent of 0 or above 100", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Bad Percent");
      const d = await makeDenom(p.id, "1 Month", "10000");
      const window = { startsAt: inHours(1), endsAt: inHours(5) };

      await expect(
        setFlashSale(prisma, { denominationId: d.id, discountPercent: "0", ...window }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setFlashSale(prisma, { denominationId: d.id, discountPercent: "101", ...window }),
      ).rejects.toBeInstanceOf(ValidationError);

      const fresh = await prisma.denomination.findUnique({ where: { id: d.id } });
      expect(fresh!.flashDiscountPercent).toBeNull();
    });

    it("rejects a window that ends before or exactly when it starts", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Bad Window");
      const d = await makeDenom(p.id, "1 Month", "10000");
      const startsAt = inHours(2);

      await expect(
        setFlashSale(prisma, { denominationId: d.id, discountPercent: "20", startsAt, endsAt: inHours(1) }),
      ).rejects.toThrow("error.invalid_flash_window");
      await expect(
        setFlashSale(prisma, { denominationId: d.id, discountPercent: "20", startsAt, endsAt: startsAt }),
      ).rejects.toThrow("error.invalid_flash_window");
    });

    it("rejects a window that is already over", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Past");
      const d = await makeDenom(p.id, "1 Month", "10000");
      await expect(
        setFlashSale(prisma, {
          denominationId: d.id,
          discountPercent: "20",
          startsAt: inHours(-5),
          endsAt: inHours(-1),
        }),
      ).rejects.toThrow("error.invalid_flash_window");
    });

    it("clears flashAnnouncedAt so a rescheduled sale is announced again", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Reschedule");
      const d = await makeDenom(p.id, "1 Month", "10000");
      await setFlashSale(prisma, {
        denominationId: d.id,
        discountPercent: "20",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });
      await prisma.denomination.update({
        where: { id: d.id },
        data: { flashAnnouncedAt: new Date() },
      });

      await setFlashSale(prisma, {
        denominationId: d.id,
        discountPercent: "25",
        startsAt: inHours(2),
        endsAt: inHours(4),
      });
      const fresh = await prisma.denomination.findUnique({ where: { id: d.id } });
      expect(fresh!.flashAnnouncedAt).toBeNull();
      expect(Number(fresh!.flashDiscountPercent)).toBe(25);
    });
  });

  describe("clearFlashSale", () => {
    it("returns false when nothing is scheduled", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash None");
      const d = await makeDenom(p.id, "1 Month", "10000");
      expect(await clearFlashSale(prisma, d.id)).toBe(false);
    });

    it("returns true and nulls every flash column", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Clearable");
      const d = await makeDenom(p.id, "1 Month", "10000");
      await setFlashSale(prisma, {
        denominationId: d.id,
        discountPercent: "20",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });
      await prisma.denomination.update({
        where: { id: d.id },
        data: { flashAnnouncedAt: new Date() },
      });

      expect(await clearFlashSale(prisma, d.id)).toBe(true);
      const fresh = await prisma.denomination.findUnique({ where: { id: d.id } });
      expect(fresh!.flashDiscountPercent).toBeNull();
      expect(fresh!.flashStartsAt).toBeNull();
      expect(fresh!.flashEndsAt).toBeNull();
      expect(fresh!.flashAnnouncedAt).toBeNull();
    });
  });

  describe("listUnannouncedStartedFlashSales", () => {
    it("returns only live, unannounced sales on active denominations", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Announce");

      const live = await makeDenom(p.id, "Live", "10000");
      await setFlashSale(prisma, {
        denominationId: live.id,
        discountPercent: "20",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });

      const notStarted = await makeDenom(p.id, "Not Started", "10000");
      await setFlashSale(prisma, {
        denominationId: notStarted.id,
        discountPercent: "20",
        startsAt: inHours(2),
        endsAt: inHours(4),
      });

      // An ended window can't be written through setFlashSale (it refuses a
      // sale that is already over), so it is planted directly — the same shape
      // a sale that simply ran its course leaves behind.
      const ended = await makeDenom(p.id, "Ended", "10000");
      await prisma.denomination.update({
        where: { id: ended.id },
        data: {
          flashDiscountPercent: "20",
          flashStartsAt: inHours(-5),
          flashEndsAt: inHours(-1),
        },
      });

      const announced = await makeDenom(p.id, "Announced", "10000");
      await setFlashSale(prisma, {
        denominationId: announced.id,
        discountPercent: "20",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });
      await prisma.denomination.update({
        where: { id: announced.id },
        data: { flashAnnouncedAt: new Date() },
      });

      const inactive = await makeDenom(p.id, "Inactive", "10000");
      await setFlashSale(prisma, {
        denominationId: inactive.id,
        discountPercent: "20",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });
      await prisma.denomination.update({ where: { id: inactive.id }, data: { isActive: false } });

      const ids = (await listUnannouncedStartedFlashSales(prisma)).map((d) => d.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(notStarted.id);
      expect(ids).not.toContain(ended.id);
      expect(ids).not.toContain(announced.id);
      expect(ids).not.toContain(inactive.id);
    });

    it("includes the parent product so the announcement can name it", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Flash Parent");
      const d = await makeDenom(p.id, "1 Month", "10000");
      await setFlashSale(prisma, {
        denominationId: d.id,
        discountPercent: "20",
        startsAt: inHours(-1),
        endsAt: inHours(1),
      });
      const row = (await listUnannouncedStartedFlashSales(prisma)).find((x) => x.id === d.id);
      expect(row!.product.name).toBe("Flash Parent");
    });
  });

  describe("listDenominationsWithFlashInfo", () => {
    it("includes inactive denominations, ordered by product then name", async () => {
      const cat = await makeCategory();
      const pB = await makeProduct(cat.id, "Zzz Product");
      const pA = await makeProduct(cat.id, "Aaa Product");
      const dInactive = await makeDenom(pA.id, "1 Month", "10000");
      await prisma.denomination.update({ where: { id: dInactive.id }, data: { isActive: false } });
      await makeDenom(pB.id, "1 Month", "10000");

      const rows = await listDenominationsWithFlashInfo(prisma);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(dInactive.id);
      const row = rows.find((r) => r.id === dInactive.id)!;
      expect(row.isActive).toBe(false);
      expect(row.product.name).toBe("Aaa Product");

      const aIndex = rows.findIndex((r) => r.product.name === "Aaa Product");
      const bIndex = rows.findIndex((r) => r.product.name === "Zzz Product");
      expect(aIndex).toBeLessThan(bIndex);
    });
  });

  describe("bulkSetFlashSale", () => {
    it("applies the same schedule to every valid id and reports overwrites", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Bulk Flash");
      const fresh = await makeDenom(p.id, "Fresh", "10000");
      const already = await makeDenom(p.id, "Already Flashed", "10000");
      await setFlashSale(prisma, { denominationId: already.id, discountPercent: "5", startsAt: inHours(-1), endsAt: inHours(1) });

      const startsAt = inHours(1);
      const endsAt = inHours(5);
      const result = await bulkSetFlashSale(prisma, {
        denominationIds: [fresh.id, already.id],
        discountPercent: "30",
        startsAt,
        endsAt,
      });

      expect(result).toEqual({ applied: 2, overwritten: 1, failed: 0 });
      const freshRow = await prisma.denomination.findUnique({ where: { id: fresh.id } });
      expect(Number(freshRow!.flashDiscountPercent)).toBe(30);
      const alreadyRow = await prisma.denomination.findUnique({ where: { id: already.id } });
      expect(Number(alreadyRow!.flashDiscountPercent)).toBe(30);
    });

    it("collects a failure for a non-existent id without aborting the rest", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Bulk Flash Partial");
      const ok = await makeDenom(p.id, "Ok", "10000");
      const missingId = ok.id + 1_000_000;

      const result = await bulkSetFlashSale(prisma, {
        denominationIds: [ok.id, missingId],
        discountPercent: "15",
        startsAt: inHours(1),
        endsAt: inHours(3),
      });

      expect(result).toEqual({ applied: 1, overwritten: 0, failed: 1 });
      const okRow = await prisma.denomination.findUnique({ where: { id: ok.id } });
      expect(Number(okRow!.flashDiscountPercent)).toBe(15);
    });

    it("collects a failure for an invalid discount percent without aborting the rest", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Bulk Flash Bad Percent");
      const a = await makeDenom(p.id, "A", "10000");
      const b = await makeDenom(p.id, "B", "10000");

      const result = await bulkSetFlashSale(prisma, {
        denominationIds: [a.id, b.id],
        discountPercent: "0",
        startsAt: inHours(1),
        endsAt: inHours(3),
      });

      expect(result).toEqual({ applied: 0, overwritten: 0, failed: 2 });
    });
  });

  describe("bulkClearFlashSale", () => {
    it("clears sales that exist and skips ones that don't", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Bulk Clear Flash");
      const withSale = await makeDenom(p.id, "With Sale", "10000");
      const withoutSale = await makeDenom(p.id, "Without Sale", "10000");
      await setFlashSale(prisma, { denominationId: withSale.id, discountPercent: "20", startsAt: inHours(-1), endsAt: inHours(1) });

      const result = await bulkClearFlashSale(prisma, [withSale.id, withoutSale.id]);
      expect(result).toEqual({ cleared: 1, skipped: 1 });
      const row = await prisma.denomination.findUnique({ where: { id: withSale.id } });
      expect(row!.flashDiscountPercent).toBeNull();
    });
  });

  describe("flashSalePerformance", () => {
    let orderSeq = 0;
    async function makeOrder(args: {
      denominationId: number;
      quantity: number;
      unitPrice: string;
      createdAt: Date;
      status?: string;
    }) {
      orderSeq++;
      const user = await upsertUser(prisma, {
        telegramId: Math.floor(Math.random() * 1_000_000_000),
        username: null,
        fullName: null,
      });
      const order = await prisma.order.create({
        data: {
          orderCode: `FSP-${orderSeq}-${Math.random()}`,
          userId: user.id,
          subtotalAmount: args.unitPrice,
          totalAmount: args.unitPrice,
          status: args.status ?? "DELIVERED",
          createdAt: args.createdAt,
        },
      });
      await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: args.denominationId,
          quantity: args.quantity,
          unitPrice: args.unitPrice,
          warrantyDaysSnapshot: 0,
        },
      });
      return order;
    }

    it("returns an empty Map immediately for an empty entries array", async () => {
      const result = await flashSalePerformance(prisma, []);
      expect(result).toEqual(new Map());
    });

    it("aggregates sold/revenue/orders per entry, filtering out-of-window and non-DELIVERED rows", async () => {
      const cat = await makeCategory();
      const p = await makeProduct(cat.id, "Perf Product");
      const d1 = await makeDenom(p.id, "D1", "10000");
      const d2 = await makeDenom(p.id, "D2", "10000");

      const t0 = new Date();
      const hour = 3_600_000;
      const entry1 = { denominationId: d1.id, startsAt: t0, endsAt: new Date(t0.getTime() + 2 * hour) };
      // entry2's window is far later, but its presence widens the single
      // over-fetch query's [min startsAt, max endsAt] range to cover t0..+12h.
      const entry2 = {
        denominationId: d2.id,
        startsAt: new Date(t0.getTime() + 10 * hour),
        endsAt: new Date(t0.getTime() + 12 * hour),
      };

      // Inside entry1's own window — counted (quantity=3 to catch a missing
      // unitPrice*quantity multiplication).
      await makeOrder({
        denominationId: d1.id,
        quantity: 3,
        unitPrice: "1000",
        createdAt: new Date(t0.getTime() + 1 * hour),
      });
      // A second DELIVERED order for d1 inside the window — should bump
      // `orders` to 2 without double-counting as the same order.
      await makeOrder({
        denominationId: d1.id,
        quantity: 1,
        unitPrice: "500",
        createdAt: new Date(t0.getTime() + 1.5 * hour),
      });
      // Same product (d1), createdAt inside the overall fetch range
      // (t0..+12h) but OUTSIDE entry1's own [t0, t0+2h] window — must be
      // excluded from entry1's aggregate despite being fetched.
      await makeOrder({
        denominationId: d1.id,
        quantity: 5,
        unitPrice: "9999",
        createdAt: new Date(t0.getTime() + 11 * hour),
      });
      // Inside entry1's window, but not DELIVERED — excluded.
      await makeOrder({
        denominationId: d1.id,
        quantity: 7,
        unitPrice: "9999",
        createdAt: new Date(t0.getTime() + 1 * hour),
        status: "PENDING_PAYMENT",
      });

      const result = await flashSalePerformance(prisma, [entry1, entry2]);

      const d1Result = result.get(d1.id)!;
      expect(d1Result.sold).toBe(4); // 3 + 1
      expect(d1Result.revenue.equals(new Decimal("3500"))).toBe(true); // 1000*3 + 500*1
      expect(d1Result.orders).toBe(2);

      const d2Result = result.get(d2.id)!;
      expect(d2Result.sold).toBe(0);
      expect(d2Result.revenue.equals(new Decimal(0))).toBe(true);
      expect(d2Result.orders).toBe(0);
    });
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

describe("flash-sale shelves", () => {
  const inHours = (h: number) => new Date(Date.now() + h * 3600_000);

  it("lists only products whose sale window is open, and reports whether any is", async () => {
    const cat = await makeCategory();

    const onSale = await makeProduct(cat.id, "Shelf Live");
    const live = await makeDenom(onSale.id, "1 Month", "10000");
    await setFlashSale(prisma, {
      denominationId: live.id,
      discountPercent: "20",
      startsAt: inHours(-1),
      endsAt: inHours(1),
    });

    // Not yet started and already finished are both "not on sale now". An
    // ended window can't be written through setFlashSale (it refuses a sale
    // that is already over), so it's planted directly.
    const upcoming = await makeProduct(cat.id, "Shelf Upcoming");
    const later = await makeDenom(upcoming.id, "1 Month", "10000");
    await setFlashSale(prisma, {
      denominationId: later.id,
      discountPercent: "20",
      startsAt: inHours(2),
      endsAt: inHours(4),
    });

    const past = await makeProduct(cat.id, "Shelf Past");
    const over = await makeDenom(past.id, "1 Month", "10000");
    await prisma.denomination.update({
      where: { id: over.id },
      data: { flashDiscountPercent: "20", flashStartsAt: inHours(-5), flashEndsAt: inHours(-1) },
    });

    const plain = await makeProduct(cat.id, "Shelf Plain");
    await makeDenom(plain.id, "1 Month", "10000");

    const slugs = (await listFlashSaleProducts(prisma)).map((p) => p.slug);
    expect(slugs).toContain(onSale.slug);
    expect(slugs).not.toContain(upcoming.slug);
    expect(slugs).not.toContain(past.slug);
    expect(slugs).not.toContain(plain.slug);
    expect(await hasActiveFlashSale(prisma)).toBe(true);
  });

  it("ignores a percent outside (0,100], the same rule pricing applies", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Shelf Bogus");
    const d = await makeDenom(p.id, "1 Month", "10000");
    // Only reachable by a hand-edited row — setFlashSale rejects it — but a
    // shelf that trusted the columns would advertise a 0%-off "sale".
    await prisma.denomination.update({
      where: { id: d.id },
      data: { flashDiscountPercent: "0", flashStartsAt: inHours(-1), flashEndsAt: inHours(1) },
    });
    const slugs = (await listFlashSaleProducts(prisma)).map((x) => x.slug);
    expect(slugs).not.toContain(p.slug);
  });

  it("reports no live sale once every window has closed", async () => {
    const cat = await makeCategory();
    const p = await makeProduct(cat.id, "Shelf Quiet");
    const d = await makeDenom(p.id, "1 Month", "10000");
    await setFlashSale(prisma, {
      denominationId: d.id,
      discountPercent: "20",
      startsAt: inHours(-1),
      endsAt: inHours(1),
    });
    // Ask as of a moment after the last window ends, rather than mutating rows.
    expect(await hasActiveFlashSale(prisma, inHours(48))).toBe(false);
    expect(await listFlashSaleProducts(prisma, inHours(48))).toEqual([]);
  });
});
