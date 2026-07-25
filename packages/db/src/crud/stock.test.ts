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
import { bulkAddStock, availableStockCountsByDenomination } from "./stock";
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

    const { added, skipped } = await bulkAddStock(prisma, product.id, [existing!.credentials, "newone@x.com:pw"]);

    expect(added).toBe(1);
    expect(skipped).toBe(1);
    // Still only ONE row with that credential string for this product.
    expect(
      await prisma.stockItem.count({ where: { productId: product.id, credentials: existing!.credentials } }),
    ).toBe(1);
  });

  it("skips a credential that's RESERVED or SOLD (not just AVAILABLE)", async () => {
    const { product } = sample;
    const rows = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 2 });
    await prisma.stockItem.update({ where: { id: rows[0]!.id }, data: { status: StockStatus.RESERVED } });
    await prisma.stockItem.update({ where: { id: rows[1]!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });

    const { added, skipped } = await bulkAddStock(prisma, product.id, [
      rows[0]!.credentials,
      rows[1]!.credentials,
      "brandnew@x.com:pw",
    ]);

    expect(added).toBe(1);
    expect(skipped).toBe(2);
  });

  it("does NOT skip a credential that's DEAD — a dead row is no longer a live duplicate", async () => {
    const { product } = sample;
    const rows = await prisma.stockItem.findMany({ where: { productId: product.id }, take: 1 });
    await prisma.stockItem.update({ where: { id: rows[0]!.id }, data: { status: StockStatus.DEAD } });

    const { added, skipped } = await bulkAddStock(prisma, product.id, [rows[0]!.credentials]);

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
    expect(
      await prisma.stockItem.count({ where: { productId: product.id, credentials: "repeat@x.com:pw" } }),
    ).toBe(1);
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

    const { added, skipped } = await bulkAddStock(prisma, otherDenom.id, [existing!.credentials]);

    expect(added).toBe(1);
    expect(skipped).toBe(0);
  });

  it("returns added=0 when every credential in the batch is a duplicate", async () => {
    const { product } = sample;
    const existing = await prisma.stockItem.findFirst({
      where: { productId: product.id, status: StockStatus.AVAILABLE },
    });

    const { added, skipped } = await bulkAddStock(prisma, product.id, [existing!.credentials]);

    expect(added).toBe(0);
    expect(skipped).toBe(1);
  });

  it("empty input returns added=0, skipped=0 without querying", async () => {
    const { product } = sample;
    expect(await bulkAddStock(prisma, product.id, [])).toEqual({ added: 0, skipped: 0 });
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
