/**
 * Admin stock maintenance — soft-delete selected items and export the
 * remaining (AVAILABLE) credentials for download. SOLD rows and anything tied
 * to an order item are never deleted, so fulfilled-order history stays intact.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { bulkDeleteStock, deleteStockItem, listAvailableCredentials } from "@app/db";
import { StockActorType, StockEventType, StockStatus } from "@app/core/enums";
import { CredentialKeyConfigError } from "@app/core/credentialCrypto";
import { encryptLegacyV1 } from "../../../../tests/helpers/envelopeFlag";
import { logger } from "@app/core/logger";

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
  it("soft-deletes selected AVAILABLE rows (deletedAt + deletedByAdminId) and returns the count", async () => {
    const { product } = sample;
    const ids = (await idsFor(product.id, StockStatus.AVAILABLE)).slice(0, 2);

    const deleted = await bulkDeleteStock(prisma, ids, sample.user.id);

    expect(deleted).toBe(2);
    // Rows stay in the table (soft delete); only the live count drops.
    expect(await prisma.stockItem.count({ where: { productId: product.id } })).toBe(5);
    expect(await prisma.stockItem.count({ where: { productId: product.id, deletedAt: null } })).toBe(3);
    const gone = await prisma.stockItem.findMany({ where: { id: { in: ids } } });
    expect(gone.every((r) => r.deletedAt !== null && r.deletedByAdminId === sample.user.id)).toBe(true);
    // Each deleted row carries exactly one SOFT_DELETED event naming the admin.
    const events = await prisma.stockItemEvent.findMany({ where: { eventType: StockEventType.SOFT_DELETED } });
    expect(events.map((e) => e.stockItemId).sort()).toEqual([...ids].sort());
    expect(events.every((e) => e.actorType === StockActorType.ADMIN && e.actorAdminId === sample.user.id)).toBe(true);
  });

  it("never deletes SOLD rows even when selected", async () => {
    const { product } = sample;
    const [soldId, ...rest] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({
      where: { id: soldId },
      data: { status: StockStatus.SOLD, soldAt: new Date() },
    });

    const deleted = await bulkDeleteStock(prisma, [soldId!, rest[0]!], sample.user.id);

    expect(deleted).toBe(1); // only the AVAILABLE one
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: soldId } })).deletedAt).toBeNull();
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

    const deleted = await bulkDeleteStock(prisma, [stockId!], sample.user.id);

    expect(deleted).toBe(0);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: stockId } })).deletedAt).toBeNull();
  });

  it("soft-deletes DEAD rows that have no order link", async () => {
    const { product } = sample;
    const [deadId] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({
      where: { id: deadId },
      data: { status: StockStatus.DEAD, note: "bad" },
    });

    expect(await bulkDeleteStock(prisma, [deadId!], sample.user.id)).toBe(1);
  });

  it("returns 0 for an empty id list", async () => {
    expect(await bulkDeleteStock(prisma, [], sample.user.id)).toBe(0);
  });

  it("does not touch an already soft-deleted row (keeps the original deletedAt)", async () => {
    const { product } = sample;
    const [id] = await idsFor(product.id, StockStatus.AVAILABLE);
    expect(await bulkDeleteStock(prisma, [id!], sample.user.id)).toBe(1);
    const first = await prisma.stockItem.findUniqueOrThrow({ where: { id } });
    expect(await bulkDeleteStock(prisma, [id!], sample.user.id)).toBe(0);
    const second = await prisma.stockItem.findUniqueOrThrow({ where: { id } });
    expect(second.deletedAt).toEqual(first.deletedAt);
  });
});

describe("deleteStockItem", () => {
  it("soft-deletes a plain AVAILABLE item and returns true", async () => {
    const { product } = sample;
    const [id] = await idsFor(product.id, StockStatus.AVAILABLE);

    const deleted = await deleteStockItem(prisma, id!, sample.user.id);

    expect(deleted).toBe(true);
    const row = await prisma.stockItem.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedByAdminId).toBe(sample.user.id);
    const events = await prisma.stockItemEvent.findMany({
      where: { stockItemId: id!, eventType: StockEventType.SOFT_DELETED },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: StockActorType.ADMIN, actorAdminId: sample.user.id });
  });

  it("returns false for an already soft-deleted item", async () => {
    const { product } = sample;
    const [id] = await idsFor(product.id, StockStatus.AVAILABLE);
    expect(await deleteStockItem(prisma, id!, sample.user.id)).toBe(true);
    expect(await deleteStockItem(prisma, id!, sample.user.id)).toBe(false);
  });

  it("refuses a SOLD item — returns false, row still exists", async () => {
    const { product } = sample;
    const [soldId] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({
      where: { id: soldId },
      data: { status: StockStatus.SOLD, soldAt: new Date() },
    });

    const deleted = await deleteStockItem(prisma, soldId!, sample.user.id);

    expect(deleted).toBe(false);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: soldId } })).deletedAt).toBeNull();
  });

  it("refuses an item tied to an order item — returns false, row still exists", async () => {
    const { product, user } = sample;
    const [stockId] = await idsFor(product.id, StockStatus.AVAILABLE);
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-LINK-DEL-1",
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

    const deleted = await deleteStockItem(prisma, stockId!, sample.user.id);

    expect(deleted).toBe(false);
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: stockId } })).deletedAt).toBeNull();
  });

  it("returns false for a non-existent id", async () => {
    expect(await deleteStockItem(prisma, 999999, sample.user.id)).toBe(false);
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

  it("skips an unreadable row with a row-id warning instead of failing the whole export", async () => {
    const { product } = sample;
    const [first] = await idsFor(product.id, StockStatus.AVAILABLE);
    const good = JSON.parse(encryptLegacyV1("gone@example.com:pw")) as Record<string, unknown>;
    await prisma.stockItem.update({
      where: { id: first },
      data: { credentials: JSON.stringify({ ...good, authTag: Buffer.alloc(16).toString("base64") }) },
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const creds = await listAvailableCredentials(prisma, product.id);
      expect(creds).toHaveLength(4);
      expect(creds).not.toContain("user1@example.com:pwd1");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatchObject({ stockItemId: first });
    } finally {
      warn.mockRestore();
    }
  });

  it("still fails loudly when the encryption key is missing", async () => {
    const { product } = sample;
    const [first] = await idsFor(product.id, StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: first }, data: { credentials: encryptLegacyV1("x@example.com:pw") } });
    const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    try {
      await expect(listAvailableCredentials(prisma, product.id)).rejects.toBeInstanceOf(CredentialKeyConfigError);
    } finally {
      process.env.CREDENTIAL_ENCRYPTION_KEY = saved;
    }
  });
});
