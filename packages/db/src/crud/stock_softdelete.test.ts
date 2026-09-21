/**
 * Soft-deleted stock rows (deletedAt set) must be invisible to every stock
 * read — counts, allocation, dedup, lists, search, reveal — while staying in
 * the table for the audit trail (stock traceability hardening, Fase 3a).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  bulkAddStock,
  listAvailableCredentials,
  countAvailableStock,
  availableStockCountsByDenomination,
  allocateOneAvailableStock,
  stockStatusCounts,
  stockStatusCountsForProduct,
  listStockItemsForProduct,
  listStockItemsForProductPage,
  countStockItemsForStatuses,
  searchStockCredentials,
  getStockItem,
  revealStockCredentials,
  markStockDead,
  bulkMarkStockDead,
} from "./stock";
import { lowStockDenominations } from "./catalog";
import { StockStatus, StockActorType } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let deletedId: number;
const deletedCred = "user1@example.com:pwd1";

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
  // Soft-delete the first of the 5 AVAILABLE rows.
  const first = await prisma.stockItem.findFirstOrThrow({
    where: { productId: sample.product.id },
    orderBy: { id: "asc" },
  });
  deletedId = first.id;
  await prisma.stockItem.update({
    where: { id: deletedId },
    data: { deletedAt: new Date(), deletedByAdminId: sample.user.id },
  });
});

describe("stock reads exclude soft-deleted rows", () => {
  it("bulkAddStock dedup ignores a soft-deleted credential (it can be re-added)", async () => {
    const res = await bulkAddStock(prisma, sample.product.id, [deletedCred]);
    expect(res).toEqual({ added: 1, skipped: 0 });
  });

  it("listAvailableCredentials", async () => {
    const creds = await listAvailableCredentials(prisma, sample.product.id);
    expect(creds).toHaveLength(4);
    expect(creds).not.toContain(deletedCred);
  });

  it("countAvailableStock", async () => {
    expect(await countAvailableStock(prisma, sample.product.id)).toBe(4);
  });

  it("availableStockCountsByDenomination", async () => {
    const m = await availableStockCountsByDenomination(prisma, [sample.product.id]);
    expect(m.get(sample.product.id)).toBe(4);
  });

  it("allocateOneAvailableStock never hands out a soft-deleted row", async () => {
    await prisma.stockItem.updateMany({
      where: { productId: sample.product.id, deletedAt: null },
      data: { status: StockStatus.SOLD },
    });
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-SD-1",
        userId: sample.user.id,
        status: "PENDING_PAYMENT",
        subtotalAmount: "5",
        totalAmount: "5",
      },
    });
    expect(
      await allocateOneAvailableStock(prisma, sample.product.id, order.id, {
        type: StockActorType.CUSTOMER,
        customerId: sample.user.id,
      }),
    ).toBeNull();
  });

  it("stockStatusCounts", async () => {
    const all = await stockStatusCounts(prisma);
    expect(all[sample.product.id]!.available).toBe(4);
  });

  it("stockStatusCountsForProduct", async () => {
    expect((await stockStatusCountsForProduct(prisma, sample.product.id)).available).toBe(4);
  });

  it("listStockItemsForProduct", async () => {
    const rows = await listStockItemsForProduct(prisma, sample.product.id);
    expect(rows.map((r) => r.id)).not.toContain(deletedId);
    expect(rows).toHaveLength(4);
  });

  it("listStockItemsForProductPage and countStockItemsForStatuses", async () => {
    const rows = await listStockItemsForProductPage(prisma, sample.product.id, [StockStatus.AVAILABLE], {
      limit: 50,
      offset: 0,
    });
    expect(rows.map((r) => r.id)).not.toContain(deletedId);
    expect(await countStockItemsForStatuses(prisma, sample.product.id, [StockStatus.AVAILABLE])).toBe(4);
  });

  it("searchStockCredentials", async () => {
    const hits = await searchStockCredentials(prisma, sample.product.id, [StockStatus.AVAILABLE], "user1@");
    expect(hits).toHaveLength(0);
  });

  it("getStockItem and revealStockCredentials treat it as not found", async () => {
    expect(await getStockItem(prisma, deletedId)).toBeNull();
    expect(await revealStockCredentials(prisma, deletedId, sample.user.id)).toBeNull();
  });

  it("markStockDead / bulkMarkStockDead leave it untouched", async () => {
    expect(await markStockDead(prisma, deletedId, "x", sample.user.id)).toBe(0);
    expect(await bulkMarkStockDead(prisma, [deletedId], "x", sample.user.id)).toBe(0);
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id: deletedId } });
    expect(row.status).toBe(StockStatus.AVAILABLE);
  });

  it("lowStockDenominations counts only live AVAILABLE rows", async () => {
    const rows = await lowStockDenominations(prisma, 4);
    expect(rows.find((r) => r.denomination.id === sample.product.id)?.available).toBe(4);
  });
});
