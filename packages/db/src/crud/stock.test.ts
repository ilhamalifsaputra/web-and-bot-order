/**
 * bulkAddStock dedup — Stock-1 fix (security audit, 2026-06-23). Two
 * identical credential strings stored as separate AVAILABLE rows could later
 * be allocated to TWO different buyers, delivering the same digital account
 * twice. bulkAddStock now skips anything already AVAILABLE/RESERVED/SOLD for
 * the product, and de-dupes the incoming batch against itself.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  bulkAddStock,
  availableStockCountsByDenomination,
  markStockDead,
  bulkMarkStockDead,
  stockStatusCountsForProduct,
  listStockItemsForProductPage,
  countStockItemsForStatuses,
  searchStockCredentials,
} from "./stock";
import { decryptCredentials } from "@app/core/credentialCrypto";
import { createDenomination } from "./catalog";
import { StockStatus } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

describe("bulkAddStock dedup", () => {
  it("inserts all-new credentials with skipped=0", async () => {
    const { product } = sample;
    const before = await prisma.stockItem.count({ where: { productId: product.id } });

    const { added, skipped } = await bulkAddStock(prisma, product.id, ["fresh1@x.com:pw", "fresh2@x.com:pw"]);

    expect(added).toBe(2);
    expect(skipped).toBe(0);
    expect(await prisma.stockItem.count({ where: { productId: product.id } })).toBe(before + 2);
  });

  it("skips a credential that already exists AVAILABLE for the same product", async () => {
    const { product } = sample;
    const existing = await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    });

    // `existing.credentials` is the stored (encrypted) column value — decrypt
    // it to get the actual plaintext account string a re-upload would submit.
    const existingPlain = decryptCredentials(existing!.credentials);
    const { added, skipped } = await bulkAddStock(prisma, product.id, [existingPlain, "newone@x.com:pw"]);

    expect(added).toBe(1);
    expect(skipped).toBe(1);
    // Still only ONE row decrypting to that credential string for this product.
    const rows = await prisma.stockItem.findMany({ where: { productId: product.id } });
    expect(rows.filter((r) => decryptCredentials(r.credentials) === existingPlain).length).toBe(1);
  });

  it("skips a credential that's RESERVED or SOLD (not just AVAILABLE)", async () => {
    const { product } = sample;
    const rows = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 2 });
    await prisma.stockItem.update({ where: { id: rows[0]!.id }, data: { status: StockStatus.RESERVED } });
    await prisma.stockItem.update({ where: { id: rows[1]!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });

    const { added, skipped } = await bulkAddStock(prisma, product.id, [
      decryptCredentials(rows[0]!.credentials),
      decryptCredentials(rows[1]!.credentials),
      "brandnew@x.com:pw",
    ]);

    expect(added).toBe(1);
    expect(skipped).toBe(2);
  });

  it("does NOT skip a credential that's DEAD — a dead row is no longer a live duplicate", async () => {
    const { product } = sample;
    const rows = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 1 });
    await prisma.stockItem.update({ where: { id: rows[0]!.id }, data: { status: StockStatus.DEAD } });

    const { added, skipped } = await bulkAddStock(prisma, product.id, [decryptCredentials(rows[0]!.credentials)]);

    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  it("de-dupes the SAME credential appearing twice within the incoming batch itself", async () => {
    const { product } = sample;
    const { added, skipped } = await bulkAddStock(prisma, product.id, [
      "repeat@x.com:pw",
      "repeat@x.com:pw",
      "unique@x.com:pw",
    ]);

    expect(added).toBe(2); // repeat@... once + unique@... once
    expect(skipped).toBe(1); // the second repeat@... in the same batch
    // Credentials are encrypted at rest with a fresh IV per row, so the
    // literal plaintext never appears in the column — decrypt to check.
    const rows = await prisma.stockItem.findMany({ where: { productId: product.id } });
    const matching = rows.filter((r) => decryptCredentials(r.credentials) === "repeat@x.com:pw");
    expect(matching.length).toBe(1);
  });

  it("the SAME credential is allowed for a DIFFERENT product (dedup is per-product)", async () => {
    const { product, parentProduct } = sample;
    const existing = await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    });
    const otherDenom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "Other denom",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });

    const { added, skipped } = await bulkAddStock(prisma, otherDenom.id, [decryptCredentials(existing!.credentials)]);

    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  it("returns added=0 when every credential in the batch is a duplicate", async () => {
    const { product } = sample;
    const existing = await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    });

    const { added, skipped } = await bulkAddStock(prisma, product.id, [decryptCredentials(existing!.credentials)]);

    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  it("empty input returns added=0, skipped=0 without querying", async () => {
    const { product } = sample;
    expect(await bulkAddStock(prisma, product.id, [])).toEqual({ added: 0, skipped: 0 });
  });
});

describe("markStockDead", () => {
  it("marks an AVAILABLE item dead and returns count=1", async () => {
    const { product } = sample;
    const item = (await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    }))!;

    const count = await markStockDead(prisma, item.id, "confirmed dead", sample.user.id);

    expect(count).toBe(1);
    const after = await prisma.stockItem.findUnique({ where: { id: item.id } });
    expect(after!.status).toBe(StockStatus.DEAD);
    expect(after!.note).toBe("confirmed dead");
  });

  it("marks a RESERVED item dead and returns count=1", async () => {
    const { product } = sample;
    const item = (await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    }))!;
    await prisma.stockItem.update({ where: { id: item.id }, data: { status: StockStatus.RESERVED } });

    const count = await markStockDead(prisma, item.id, "confirmed dead", sample.user.id);

    expect(count).toBe(1);
    expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.status).toBe(StockStatus.DEAD);
  });

  it("refuses to alter a SOLD (delivered) item — returns count=0, status unchanged", async () => {
    const { product } = sample;
    const item = (await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    }))!;
    await prisma.stockItem.update({
      where: { id: item.id },
      data: { status: StockStatus.SOLD, soldAt: new Date() },
    });

    const count = await markStockDead(prisma, item.id, "mis-tap by admin", sample.user.id);

    expect(count).toBe(0);
    const after = await prisma.stockItem.findUnique({ where: { id: item.id } });
    expect(after!.status).toBe(StockStatus.SOLD);
    // The note (and everything else about the delivered credential) is untouched.
    expect(after!.note).toBeNull();
  });

  it("no-ops on an already-DEAD item — returns count=0", async () => {
    const { product } = sample;
    const item = (await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    }))!;
    await prisma.stockItem.update({ where: { id: item.id }, data: { status: StockStatus.DEAD, note: "first note" } });

    const count = await markStockDead(prisma, item.id, "second note", sample.user.id);

    expect(count).toBe(0);
    expect((await prisma.stockItem.findUnique({ where: { id: item.id } }))!.note).toBe("first note");
  });

  it("returns count=0 for a non-existent stock id", async () => {
    expect(await markStockDead(prisma, 999999, "n/a", sample.user.id)).toBe(0);
  });

  it("uses the identical status filter as bulkMarkStockDead (SOLD excluded from both)", async () => {
    const { product } = sample;
    const items = await prisma.stockItem.findMany({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
      take: 2,
    });
    await prisma.stockItem.update({ where: { id: items[0]!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });

    const singleCount = await markStockDead(prisma, items[0]!.id, "x", sample.user.id);
    const bulkCount = await bulkMarkStockDead(prisma, [items[1]!.id], "x", sample.user.id);

    expect(singleCount).toBe(0);
    expect(bulkCount).toBe(1);
  });
});

describe("bulkAddStock encrypts credentials at rest", () => {
  it("never stores the plaintext credential in the column", async () => {
    const { product } = sample;
    await bulkAddStock(prisma, product.id, ["encrypt-me@x.com:pw"]);

    const row = (await prisma.stockItem.findFirst({
      where: { productId: product.id, credentials: { contains: "encrypt-me" } },
    }))!;
    expect(row).toBeNull(); // the literal plaintext is not a substring of the stored value

    const all = await prisma.stockItem.findMany({ where: { productId: product.id } });
    const stored = all.find((r) => decryptCredentials(r.credentials) === "encrypt-me@x.com:pw");
    expect(stored).toBeDefined();
    expect(stored!.credentials).not.toBe("encrypt-me@x.com:pw");
    expect(() => JSON.parse(stored!.credentials)).not.toThrow();
  });
});

describe("availableStockCountsByDenomination", () => {
  it("returns an empty Map for an empty id array", async () => {
    expect(await availableStockCountsByDenomination(prisma, [])).toEqual(new Map());
  });

  it("counts only AVAILABLE rows, grouped per denomination, omitting ids with none", async () => {
    const { product, parentProduct } = sample; // `product` already has 5 AVAILABLE rows from buildSampleData

    const otherDenom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "No stock left",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });
    // Give otherDenom stock, but mark it all SOLD/DEAD — no AVAILABLE rows.
    await bulkAddStock(prisma, otherDenom.id, ["sold-one@x.com:pw", "dead-one@x.com:pw"]);
    const otherRows = await prisma.stockItem.findMany({ where: { productId: otherDenom.id } });
    await prisma.stockItem.update({ where: { id: otherRows[0]!.id }, data: { status: StockStatus.SOLD } });
    await prisma.stockItem.update({ where: { id: otherRows[1]!.id }, data: { status: StockStatus.DEAD } });

    const untouchedDenom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "Never had stock",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });

    const result = await availableStockCountsByDenomination(prisma, [
      product.id,
      otherDenom.id,
      untouchedDenom.id,
    ]);

    expect(result.get(product.id)).toBe(5);
    expect(result.has(otherDenom.id)).toBe(false);
    expect(result.has(untouchedDenom.id)).toBe(false);
  });
});

describe("stockStatusCountsForProduct", () => {
  it("returns accurate counts scoped to the single product", async () => {
    const { product, parentProduct } = sample;
    // sample.product already has stock rows from buildSampleData

    const counts = await stockStatusCountsForProduct(prisma, product.id);

    expect(counts).toHaveProperty("available");
    expect(counts).toHaveProperty("reserved");
    expect(counts).toHaveProperty("sold");
    expect(counts).toHaveProperty("dead");
    expect(counts.available).toBeGreaterThan(0); // sample has AVAILABLE rows
    expect(counts.reserved).toBe(0); // sample starts with all AVAILABLE
  });

  it("does NOT leak counts from other products", async () => {
    const { product, parentProduct } = sample;

    // Add stock to another denomination (different product)
    const otherDenom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "Other denom",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });
    await bulkAddStock(prisma, otherDenom.id, ["other1@x.com:pw", "other2@x.com:pw"]);

    const productCounts = await stockStatusCountsForProduct(prisma, product.id);
    const otherCounts = await stockStatusCountsForProduct(prisma, otherDenom.id);

    expect(productCounts.available).toBeGreaterThan(0);
    expect(otherCounts.available).toBe(2);
    // They should not be equal — different products
    expect(productCounts.available).not.toBe(otherCounts.available);
  });

  it("correctly counts items with mixed statuses for a product", async () => {
    const { product } = sample;
    const items = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 3 });

    // Change statuses
    await prisma.stockItem.update({ where: { id: items[0]!.id }, data: { status: StockStatus.RESERVED } });
    await prisma.stockItem.update({
      where: { id: items[1]!.id },
      data: { status: StockStatus.SOLD, soldAt: new Date() },
    });
    await prisma.stockItem.update({ where: { id: items[2]!.id }, data: { status: StockStatus.DEAD } });

    const counts = await stockStatusCountsForProduct(prisma, product.id);

    expect(counts.reserved).toBe(1);
    expect(counts.sold).toBe(1);
    expect(counts.dead).toBe(1);
  });
});

describe("listStockItemsForProductPage", () => {
  it("respects limit and returns correct number of items", async () => {
    const { product } = sample;

    const page1 = await listStockItemsForProductPage(prisma, product.id, [StockStatus.AVAILABLE], {
      limit: 2,
      offset: 0,
    });

    expect(page1.length).toBe(2);
  });

  it("respects offset and returns items from the correct page", async () => {
    const { product } = sample;

    const page1 = await listStockItemsForProductPage(prisma, product.id, [StockStatus.AVAILABLE], {
      limit: 2,
      offset: 0,
    });
    const page2 = await listStockItemsForProductPage(prisma, product.id, [StockStatus.AVAILABLE], {
      limit: 2,
      offset: 2,
    });

    // Pages should be different
    if (page1.length > 0 && page2.length > 0) {
      expect(page1[0]!.id).not.toBe(page2[0]!.id);
    }
  });

  it("filters by status correctly", async () => {
    const { product } = sample;
    const items = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 1 });

    // Change one to RESERVED
    await prisma.stockItem.update({ where: { id: items[0]!.id }, data: { status: StockStatus.RESERVED } });

    const availableOnly = await listStockItemsForProductPage(prisma, product.id, [StockStatus.AVAILABLE], {
      limit: 100,
      offset: 0,
    });
    const reservedOnly = await listStockItemsForProductPage(prisma, product.id, [StockStatus.RESERVED], {
      limit: 100,
      offset: 0,
    });

    expect(availableOnly.every((r) => r.status === StockStatus.AVAILABLE)).toBe(true);
    expect(reservedOnly.every((r) => r.status === StockStatus.RESERVED)).toBe(true);
  });

  it("orders results by id ascending", async () => {
    const { product } = sample;

    const results = await listStockItemsForProductPage(prisma, product.id, [StockStatus.AVAILABLE], {
      limit: 100,
      offset: 0,
    });

    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.id).toBeGreaterThan(results[i - 1]!.id);
    }
  });
});

describe("countStockItemsForStatuses", () => {
  it("returns the correct count for a status group", async () => {
    const { product } = sample;

    const count = await countStockItemsForStatuses(prisma, product.id, [StockStatus.AVAILABLE]);

    expect(count).toBeGreaterThan(0);
    const actual = await prisma.stockItem.count({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    });
    expect(count).toBe(actual);
  });

  it("counts multiple statuses correctly", async () => {
    const { product } = sample;
    const items = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 2 });

    // Change one to RESERVED
    if (items[0]) {
      await prisma.stockItem.update({ where: { id: items[0].id }, data: { status: StockStatus.RESERVED } });
    }

    const count = await countStockItemsForStatuses(prisma, product.id, [
      StockStatus.AVAILABLE,
      StockStatus.RESERVED,
    ]);

    const expected = await prisma.stockItem.count({
      where: {
        productId: product.id,
        status: { in: [StockStatus.AVAILABLE, StockStatus.RESERVED] },
      },
    });
    expect(count).toBe(expected);
  });

  it("returns 0 for an empty product", async () => {
    const { product, parentProduct } = sample;
    const emptyDenom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "Empty",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });

    const count = await countStockItemsForStatuses(prisma, emptyDenom.id, [StockStatus.AVAILABLE]);

    expect(count).toBe(0);
  });
});

describe("searchStockCredentials", () => {
  it("finds a row by substring of credentials", async () => {
    const { product } = sample;

    // Add stock with a known credential
    await bulkAddStock(prisma, product.id, ["test-search@example.com:password123"]);

    const results = await searchStockCredentials(prisma, product.id, [StockStatus.AVAILABLE], "test-search");

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => decryptCredentials(r.credentials).includes("test-search"))).toBe(true);
  });

  it("finds a row by substring of note", async () => {
    const { product } = sample;
    const item = (await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    }))!;

    // Set a note
    await prisma.stockItem.update({ where: { id: item.id }, data: { note: "important-tag-123" } });

    const results = await searchStockCredentials(prisma, product.id, [StockStatus.AVAILABLE], "important-tag");

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id === item.id)).toBe(true);
  });

  it("does NOT match unrelated rows", async () => {
    const { product, parentProduct } = sample;

    const otherDenom = await createDenomination(prisma, {
      productId: parentProduct.id,
      name: "Other",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
    });
    await bulkAddStock(prisma, otherDenom.id, ["other@x.com:pw"]);

    const results = await searchStockCredentials(prisma, otherDenom.id, [StockStatus.AVAILABLE], "product");

    // Should not find anything from sample.product in the other product
    expect(results.length).toBe(0);
  });

  it("is case-insensitive", async () => {
    const { product } = sample;
    await bulkAddStock(prisma, product.id, ["CaseTest@Example.COM:pwd"]);

    const results = await searchStockCredentials(prisma, product.id, [StockStatus.AVAILABLE], "casetest");

    expect(results.length).toBeGreaterThan(0);
  });

  it("respects status filter", async () => {
    const { product } = sample;
    const items = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 1 });

    if (items[0]) {
      await prisma.stockItem.update({
        where: { id: items[0].id },
        data: { status: StockStatus.RESERVED },
      });

      const plainCredential = decryptCredentials(items[0]!.credentials);

      // Search for AVAILABLE only should not find the RESERVED item
      const resultsAvailable = await searchStockCredentials(
        prisma,
        product.id,
        [StockStatus.AVAILABLE],
        plainCredential,
      );
      expect(resultsAvailable.every((r) => r.id !== items[0]!.id)).toBe(true);

      // Search for RESERVED should find it
      const resultsReserved = await searchStockCredentials(
        prisma,
        product.id,
        [StockStatus.RESERVED],
        plainCredential,
      );
      expect(resultsReserved.some((r) => r.id === items[0]!.id)).toBe(true);
    }
  });
});
