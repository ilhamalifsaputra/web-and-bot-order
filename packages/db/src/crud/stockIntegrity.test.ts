/**
 * checkStockIntegrity (stock traceability hardening plan, Fase 4a) — a
 * read-only report of the invariants a DB-level CHECK/unique constraint would
 * normally enforce, substituting for those constraints because this repo's
 * real deploy path is `prisma db push`, which never applies raw-SQL-only
 * constructs (see stockIntegrity.ts's header comment and docs/MIGRATIONS.md).
 *
 * Each violation scenario is seeded directly with `prisma.*.update`/`create`,
 * bypassing the crud helpers that would normally prevent it — the same
 * pattern stock_events.test.ts uses for its "guard refuses" cases — because
 * the point of this checker is to detect data that already reached an
 * invalid state (legacy rows, a bug in an earlier phase), not to re-test the
 * guards that stop new invalid writes.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { checkStockIntegrity } from "./stockIntegrity";
import { createDenomination } from "./catalog";
import { bulkAddStock } from "./stock";
import { StockStatus, OrderStatus } from "@app/core/enums";
import { encryptCredentials } from "@app/core/credentialCrypto";

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

const rowsByStatus = async (status: string) =>
  prisma.stockItem.findMany({ where: { productId: sample.product.id, status }, orderBy: { id: "asc" } });

/** Minimal raw Order+OrderItem insert, bypassing createOrderDirect (which
 * would never leave two items pointing at the same StockItem, or an
 * order-item pointer un-nulled on cancel) so a scenario can force exactly the
 * shape a legacy bug would have left behind. */
async function rawOrderWithItem(orderCode: string, status: string, stockItemId: number | null) {
  const order = await prisma.order.create({
    data: {
      orderCode,
      userId: sample.user.id,
      status,
      subtotalAmount: "5.0000",
      totalAmount: "5.0000",
      items: {
        create: {
          productId: sample.product.id,
          stockItemId,
          quantity: 1,
          unitPrice: "5.0000",
          warrantyDaysSnapshot: 30,
        },
      },
    },
    include: { items: true },
  });
  return { order, item: order.items[0]! };
}

/** A bare Order row (no items) — `stock_items.order_id` FK-references a real
 * order, so any scenario that sets StockItem.orderId needs one, even when the
 * scenario itself is not about OrderItem linkage. */
async function rawOrder(orderCode: string, status: string) {
  return prisma.order.create({
    data: { orderCode, userId: sample.user.id, status, subtotalAmount: "5.0000", totalAmount: "5.0000" },
  });
}

const emptyFinding = { count: 0, sampleIds: [] };

describe("checkStockIntegrity — clean database", () => {
  it("returns an all-zero report against the fresh fixture (5 AVAILABLE rows, no orders)", async () => {
    const report = await checkStockIntegrity(prisma);
    expect(report).toEqual({
      reservedOrSoldWithoutOrderId: emptyFinding,
      soldWithoutSoldAt: emptyFinding,
      statusOutsideEnum: emptyFinding,
      duplicateStockItemPointers: emptyFinding,
      softDeletedStillReserved: emptyFinding,
      statusEventMismatch: emptyFinding,
      legacyRowsWithoutEvents: 0,
      cancelledOrRejectedOrderItemsStillLinked: emptyFinding,
      duplicateActiveCredentialFingerprints: emptyFinding,
    });
  });
});

describe("checkStockIntegrity — reservedOrSoldWithoutOrderId", () => {
  it("flags RESERVED and SOLD rows that carry no orderId", async () => {
    const [reserved, sold] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: reserved!.id }, data: { status: StockStatus.RESERVED } });
    await prisma.stockItem.update({ where: { id: sold!.id }, data: { status: StockStatus.SOLD, soldAt: new Date() } });

    const report = await checkStockIntegrity(prisma);
    expect(report.reservedOrSoldWithoutOrderId.count).toBe(2);
    expect(report.reservedOrSoldWithoutOrderId.sampleIds.sort((a, b) => a - b)).toEqual(
      [reserved!.id, sold!.id].sort((a, b) => a - b),
    );
  });

  it("does not flag a RESERVED/SOLD row that does carry an orderId", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const order = await rawOrder("ORD-HAS-ORDERID", OrderStatus.PAID);
    await prisma.stockItem.update({ where: { id: row!.id }, data: { status: StockStatus.RESERVED, orderId: order.id } });

    const report = await checkStockIntegrity(prisma);
    expect(report.reservedOrSoldWithoutOrderId).toEqual(emptyFinding);
  });

  it("bounds the sample at 20 ids while still reporting the true count", async () => {
    const denom = await createDenomination(prisma, {
      productId: sample.parentProduct.id,
      name: "Bulk violation denom",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
      warrantyDays: 30,
    });
    await bulkAddStock(
      prisma,
      denom.id,
      Array.from({ length: 25 }, (_, i) => `bulk${i}@x:pw`),
    );
    await prisma.stockItem.updateMany({ where: { productId: denom.id }, data: { status: StockStatus.RESERVED } });

    const report = await checkStockIntegrity(prisma);
    expect(report.reservedOrSoldWithoutOrderId.count).toBe(25);
    expect(report.reservedOrSoldWithoutOrderId.sampleIds).toHaveLength(20);
  });
});

describe("checkStockIntegrity — soldWithoutSoldAt", () => {
  it("flags a SOLD row with no soldAt", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const order = await rawOrder("ORD-SOLD-NO-SOLDAT", OrderStatus.PAID);
    await prisma.stockItem.update({ where: { id: row!.id }, data: { status: StockStatus.SOLD, orderId: order.id } });

    const report = await checkStockIntegrity(prisma);
    expect(report.soldWithoutSoldAt).toEqual({ count: 1, sampleIds: [row!.id] });
  });

  it("does not flag a SOLD row that does carry soldAt", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const order = await rawOrder("ORD-SOLD-WITH-SOLDAT", OrderStatus.PAID);
    await prisma.stockItem.update({
      where: { id: row!.id },
      data: { status: StockStatus.SOLD, orderId: order.id, soldAt: new Date() },
    });

    const report = await checkStockIntegrity(prisma);
    expect(report.soldWithoutSoldAt).toEqual(emptyFinding);
  });
});

describe("checkStockIntegrity — statusOutsideEnum", () => {
  it("flags a row whose status is not one of the StockStatus values", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: row!.id }, data: { status: "WEIRD_LEGACY_STATUS" } });

    const report = await checkStockIntegrity(prisma);
    expect(report.statusOutsideEnum).toEqual({ count: 1, sampleIds: [row!.id] });
  });
});

describe("checkStockIntegrity — duplicateStockItemPointers", () => {
  it("flags a StockItem id referenced by more than one OrderItem", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await rawOrderWithItem("ORD-DUP-1", OrderStatus.PAID, row!.id);
    await rawOrderWithItem("ORD-DUP-2", OrderStatus.PAID, row!.id);

    const report = await checkStockIntegrity(prisma);
    expect(report.duplicateStockItemPointers).toEqual({ count: 1, sampleIds: [row!.id] });
  });

  it("does not flag a StockItem id referenced by only one OrderItem", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await rawOrderWithItem("ORD-SINGLE-1", OrderStatus.PAID, row!.id);

    const report = await checkStockIntegrity(prisma);
    expect(report.duplicateStockItemPointers).toEqual(emptyFinding);
  });
});

describe("checkStockIntegrity — softDeletedStillReserved", () => {
  it("flags a soft-deleted row that is still RESERVED", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const order = await rawOrder("ORD-SOFTDEL-RESERVED", OrderStatus.PAID);
    await prisma.stockItem.update({
      where: { id: row!.id },
      data: { status: StockStatus.RESERVED, orderId: order.id, deletedAt: new Date(), deletedByAdminId: user.id },
    });

    const report = await checkStockIntegrity(prisma);
    expect(report.softDeletedStillReserved).toEqual({ count: 1, sampleIds: [row!.id] });
  });

  it("does not flag a soft-deleted row that is AVAILABLE", async () => {
    const { user } = sample;
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({
      where: { id: row!.id },
      data: { deletedAt: new Date(), deletedByAdminId: user.id },
    });

    const report = await checkStockIntegrity(prisma);
    expect(report.softDeletedStillReserved).toEqual(emptyFinding);
  });
});

describe("checkStockIntegrity — statusEventMismatch / legacyRowsWithoutEvents", () => {
  it("flags a row whose latest event disagrees with its current status", async () => {
    // buildSampleData's bulkAddStock left this row's only event as
    // IMPORTED(toStatus=AVAILABLE); moving the column to RESERVED without a
    // matching event is exactly the drift this check exists to catch.
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const order = await rawOrder("ORD-STATUS-MISMATCH", OrderStatus.PAID);
    await prisma.stockItem.update({ where: { id: row!.id }, data: { status: StockStatus.RESERVED, orderId: order.id } });

    const report = await checkStockIntegrity(prisma);
    expect(report.statusEventMismatch).toEqual({ count: 1, sampleIds: [row!.id] });
  });

  it("does not flag a row whose latest event matches its current status", async () => {
    const report = await checkStockIntegrity(prisma);
    expect(report.statusEventMismatch).toEqual(emptyFinding);
  });

  it("counts a row with zero events as legacy, not as a mismatch", async () => {
    const legacy = await prisma.stockItem.create({
      data: {
        productId: sample.product.id,
        credentials: encryptCredentials("legacy@x:pw"),
        status: StockStatus.AVAILABLE,
      },
    });

    const report = await checkStockIntegrity(prisma);
    expect(report.legacyRowsWithoutEvents).toBe(1);
    expect(report.statusEventMismatch).toEqual(emptyFinding);
    // sanity: the row really has no events
    expect(await prisma.stockItemEvent.count({ where: { stockItemId: legacy.id } })).toBe(0);
  });
});

describe("checkStockIntegrity — cancelledOrRejectedOrderItemsStillLinked", () => {
  it("flags an OrderItem of a CANCELLED order that still points at a StockItem", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const { item } = await rawOrderWithItem("ORD-CANCELLED-LINKED", OrderStatus.CANCELLED, row!.id);

    const report = await checkStockIntegrity(prisma);
    expect(report.cancelledOrRejectedOrderItemsStillLinked).toEqual({ count: 1, sampleIds: [item.id] });
  });

  it("flags an OrderItem of a REJECTED order that still points at a StockItem", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    const { item } = await rawOrderWithItem("ORD-REJECTED-LINKED", OrderStatus.REJECTED, row!.id);

    const report = await checkStockIntegrity(prisma);
    expect(report.cancelledOrRejectedOrderItemsStillLinked).toEqual({ count: 1, sampleIds: [item.id] });
  });

  it("does not flag a CANCELLED order's item once the pointer is nulled (the 3b-fixed path)", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await rawOrderWithItem("ORD-CANCELLED-CLEARED", OrderStatus.CANCELLED, null);
    void row;

    const report = await checkStockIntegrity(prisma);
    expect(report.cancelledOrRejectedOrderItemsStillLinked).toEqual(emptyFinding);
  });

  it("does not flag a PAID order's item that still points at a StockItem", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await rawOrderWithItem("ORD-PAID-LINKED", OrderStatus.PAID, row!.id);

    const report = await checkStockIntegrity(prisma);
    expect(report.cancelledOrRejectedOrderItemsStillLinked).toEqual(emptyFinding);
  });
});

describe("checkStockIntegrity — duplicateActiveCredentialFingerprints", () => {
  it("is all-NULL tolerant: NULL fingerprints (Fase 5 not populated yet) never count as duplicates", async () => {
    const rows = await rowsByStatus(StockStatus.AVAILABLE);
    expect(rows.every((r) => r.credentialFingerprint === null)).toBe(true);

    const report = await checkStockIntegrity(prisma);
    expect(report.duplicateActiveCredentialFingerprints).toEqual(emptyFinding);
  });

  it("flags two active rows of the same denomination sharing a fingerprint", async () => {
    const [a, b] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: a!.id }, data: { credentialFingerprint: "fp-dup" } });
    await prisma.stockItem.update({ where: { id: b!.id }, data: { credentialFingerprint: "fp-dup" } });

    const report = await checkStockIntegrity(prisma);
    expect(report.duplicateActiveCredentialFingerprints.count).toBe(2);
    expect(report.duplicateActiveCredentialFingerprints.sampleIds.sort((x, y) => x - y)).toEqual(
      [a!.id, b!.id].sort((x, y) => x - y),
    );
  });

  it("does not flag a shared fingerprint once one of the two rows is DEAD", async () => {
    const [a, b] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: a!.id }, data: { credentialFingerprint: "fp-dup-dead" } });
    await prisma.stockItem.update({
      where: { id: b!.id },
      data: { credentialFingerprint: "fp-dup-dead", status: StockStatus.DEAD },
    });

    const report = await checkStockIntegrity(prisma);
    expect(report.duplicateActiveCredentialFingerprints).toEqual(emptyFinding);
  });

  it("does not flag the same fingerprint value shared across two different denominations", async () => {
    const denom2 = await createDenomination(prisma, {
      productId: sample.parentProduct.id,
      name: "Other denom",
      type: "SHARED",
      durationLabel: "1 month",
      price: "5.00",
      warrantyDays: 30,
    });
    await bulkAddStock(prisma, denom2.id, ["other@x:pw"]);
    const [a] = await rowsByStatus(StockStatus.AVAILABLE);
    const [b] = await prisma.stockItem.findMany({ where: { productId: denom2.id } });
    await prisma.stockItem.update({ where: { id: a!.id }, data: { credentialFingerprint: "fp-cross-denom" } });
    await prisma.stockItem.update({ where: { id: b!.id }, data: { credentialFingerprint: "fp-cross-denom" } });

    const report = await checkStockIntegrity(prisma);
    expect(report.duplicateActiveCredentialFingerprints).toEqual(emptyFinding);
  });
});

describe("checkStockIntegrity — never exposes credential text", () => {
  it("no field of the report ever contains a decrypted or encrypted credential string", async () => {
    const [row] = await rowsByStatus(StockStatus.AVAILABLE);
    await prisma.stockItem.update({ where: { id: row!.id }, data: { status: "WEIRD_LEGACY_STATUS" } });
    const rawRow = await prisma.stockItem.findUniqueOrThrow({ where: { id: row!.id } });

    const report = await checkStockIntegrity(prisma);
    const dump = JSON.stringify(report);
    expect(dump).not.toContain(rawRow.credentials);
  });
});
