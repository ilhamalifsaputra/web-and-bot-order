/**
 * Admin stock maintenance — hard-delete selected items and export the
 * remaining (AVAILABLE) credentials for download. SOLD rows and anything tied
 * to an order item are never deleted, so fulfilled-order history stays intact.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { bulkDeleteStock, listAvailableCredentials } from "@app/db";
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

const idsFor = async (productId: number, status: string) =>
  (await prisma.stockItem.findMany({ where: { productId, status }, select: { id: true } })).map(
    (r) => r.id,
  );

describe("bulkDeleteStock", () => {
  it("hard-deletes selected AVAILABLE rows and returns the count", async () => {
    const { product } = sample;
    const ids = (await idsFor(product.id, StockStatus.AVAILABLE)).slice(0, 2);

    const deleted = await bulkDeleteStock(prisma, ids);

    expect(deleted).toBe(2);
    expect(await prisma.stockItem.count({ where: { productId: product.id } })).toBe(3);
  });

  it("never deletes SOLD rows even when selected", async () => {
    const { product } = sample;
    const [soldId, ...rest] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({
      where: { id: soldId },
      data: { status: StockStatus.SOLD, soldAt: new Date() },
    });

    const deleted = await bulkDeleteStock(prisma, [soldId!, rest[0]!]);

    expect(deleted).toBe(1); // only the AVAILABLE one
    expect(await prisma.stockItem.findUnique({ where: { id: soldId } })).not.toBeNull();
  });

  it("never deletes rows tied to an order item", async () => {
    const { product, user } = sample;
    const [stockId] = await idsFor(product.id, StockStatus.AVAILABLE);
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-LINK-1",
        userId: user.id,
        status: "DELIVERED",
        subtotalAmount: "5.0000",
        totalAmount: "5.0000",
        items: {
          create: {
            productId: product.id,
            stockItemId: stockId,
            quantity: 1,
            unitPrice: "5.0000",
            warrantyDaysSnapshot: 30,
          },
        },
      },
    });
    expect(order.id).toBeGreaterThan(0);

    const deleted = await bulkDeleteStock(prisma, [stockId!]);

    expect(deleted).toBe(0);
    expect(await prisma.stockItem.findUnique({ where: { id: stockId } })).not.toBeNull();
  });

  it("deletes DEAD rows that have no order link", async () => {
    const { product } = sample;
    const [deadId] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({
      where: { id: deadId },
      data: { status: StockStatus.DEAD, note: "bad" },
    });

    expect(await bulkDeleteStock(prisma, [deadId!])).toBe(1);
  });

  it("returns 0 for an empty id list", async () => {
    expect(await bulkDeleteStock(prisma, [])).toBe(0);
  });
});

describe("listAvailableCredentials", () => {
  it("returns only AVAILABLE credentials, ordered by id", async () => {
    const { product } = sample;
    const creds = await listAvailableCredentials(prisma, product.id);
    expect(creds).toEqual([
      "user1@example.com:pwd1",
      "user2@example.com:pwd2",
      "user3@example.com:pwd3",
      "user4@example.com:pwd4",
      "user5@example.com:pwd5",
    ]);
  });

  it("excludes RESERVED, SOLD and DEAD rows", async () => {
    const { product } = sample;
    const [a, b] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: a }, data: { status: StockStatus.SOLD } });
    await prisma.stockItem.update({ where: { id: b }, data: { status: StockStatus.DEAD } });

    const creds = await listAvailableCredentials(prisma, product.id);
    expect(creds).toHaveLength(3);
    expect(creds).not.toContain("user1@example.com:pwd1");
    expect(creds).not.toContain("user2@example.com:pwd2");
  });
});
