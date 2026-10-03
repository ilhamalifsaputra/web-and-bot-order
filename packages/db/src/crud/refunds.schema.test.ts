/**
 * Structural/shape tests for the Refund + RefundItem schema (Trustance
 * Master Architecture Task 8a). SCHEMA-ONLY task — there is no crud layer,
 * no state machine, and no wallet wiring yet (that's task 8b), so this file
 * proves the migration applies cleanly and the tables/columns/relations/FK
 * policy are shaped exactly as documented in schema.prisma. It does NOT
 * assert any business logic (no refund-sum invariant enforcement — that is
 * explicitly deferred to the application layer per RefundItem's doc
 * comment, and covered by task 8b's own tests).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";

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

async function makeOrderWithItem(quantity = 1) {
  const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity });
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order!.id } });
  return { order: order!, item };
}

describe("Refund — shape", () => {
  it("creates with only the required fields, defaulting status to PENDING", async () => {
    const { order } = await makeOrderWithItem();

    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: new Prisma.Decimal("5.00"),
        currency: "IDR",
      },
    });

    expect(refund.status).toBe("PENDING");
    expect(refund.reason).toBeNull();
    expect(refund.externalReference).toBeNull();
    expect(refund.processedAt).toBeNull();
    expect(refund.createdAt).toBeInstanceOf(Date);
    expect(refund.updatedAt).toBeInstanceOf(Date);
  });

  it("stores amount as a Decimal, not a float, matching the repo's money convention", async () => {
    const { order } = await makeOrderWithItem();

    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("1234.5678"), currency: "USDT" },
    });

    expect(refund.amount).toBeInstanceOf(Prisma.Decimal);
    expect(refund.amount.toString()).toBe("1234.5678");
  });

  it("accepts every documented status value", async () => {
    const { order } = await makeOrderWithItem();
    for (const status of ["PENDING", "PROCESSING", "COMPLETED", "FAILED", "CANCELLED"]) {
      const refund = await prisma.refund.create({
        data: { orderId: order.id, amount: new Prisma.Decimal("1.00"), currency: "IDR", status },
      });
      expect(refund.status).toBe(status);
    }
  });

  it("carries reason (free text) and externalReference through, unconstrained", async () => {
    const { order } = await makeOrderWithItem();

    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        amount: new Prisma.Decimal("5.00"),
        currency: "IDR",
        reason: "Dead account, buyer confirmed on ticket #123 — any free-text sentence is accepted.",
        externalReference: "manual-note:bank-transfer-2026-08-25",
        status: "COMPLETED",
        processedAt: new Date(),
      },
    });

    expect(refund.reason).toContain("Dead account");
    expect(refund.externalReference).toBe("manual-note:bank-transfer-2026-08-25");
    expect(refund.processedAt).toBeInstanceOf(Date);
  });

  it("exposes the order relation and its reverse Order.refunds[] list", async () => {
    const { order } = await makeOrderWithItem();
    await prisma.refund.create({ data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" } });

    const withOrder = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id }, include: { order: true } });
    expect(withOrder.order.id).toBe(order.id);

    const orderWithRefunds = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { refunds: true },
    });
    expect(orderWithRefunds.refunds).toHaveLength(1);
  });

  it("rejects creating a Refund against a non-existent order (FK enforced)", async () => {
    await expect(
      prisma.refund.create({ data: { orderId: 999_999_999, amount: new Prisma.Decimal("5.00"), currency: "IDR" } }),
    ).rejects.toThrow();
  });

  it("Restricts (does not cascade) deleting the referenced Order while a Refund exists", async () => {
    const { order } = await makeOrderWithItem();
    await prisma.refund.create({ data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" } });

    // No crud helper deletes an Order today (per CLAUDE.md / this schema's
    // convention) — this proves the DB-level guardrail exists independent
    // of that, by attempting the raw delete directly.
    await expect(prisma.order.delete({ where: { id: order.id } })).rejects.toThrow();
  });
});

describe("RefundItem — shape", () => {
  it("creates rows tied to a Refund and an OrderItem, carrying an independent amount/currency/reason", async () => {
    const { order, item } = await makeOrderWithItem();
    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR", reason: "partial: 1 of 1 dead" },
    });

    const refundItem = await prisma.refundItem.create({
      data: {
        refundId: refund.id,
        orderItemId: item.id,
        amount: new Prisma.Decimal("5.00"),
        currency: "IDR",
        reason: "account banned within 24h",
      },
    });

    expect(refundItem.amount).toBeInstanceOf(Prisma.Decimal);
    expect(refundItem.amount.toString()).toBe("5");
    expect(refundItem.currency).toBe("IDR");
    expect(refundItem.reason).toBe("account banned within 24h");
    expect(refundItem.createdAt).toBeInstanceOf(Date);
  });

  it("supports several RefundItem rows against the same OrderItem (multiple partial refunds over time)", async () => {
    const { order, item } = await makeOrderWithItem(3);
    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("15.00"), currency: "IDR" },
    });

    await prisma.refundItem.create({
      data: { refundId: refund.id, orderItemId: item.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });
    await prisma.refundItem.create({
      data: { refundId: refund.id, orderItemId: item.id, amount: new Prisma.Decimal("10.00"), currency: "IDR" },
    });

    const rows = await prisma.refundItem.findMany({ where: { orderItemId: item.id } });
    expect(rows).toHaveLength(2);
    // The application layer (task 8b), not the schema, is responsible for
    // summing these against the OrderItem's subtotal — this only proves the
    // schema provides everything that future check needs to read.
    const sum = rows.reduce((acc, r) => acc.plus(r.amount), new Prisma.Decimal(0));
    expect(sum.toString()).toBe("15");
  });

  it("exposes the refund relation and its reverse Refund.items[] list", async () => {
    const { order, item } = await makeOrderWithItem();
    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });
    await prisma.refundItem.create({
      data: { refundId: refund.id, orderItemId: item.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });

    const withItems = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id }, include: { items: true } });
    expect(withItems.items).toHaveLength(1);

    const withRefund = await prisma.refundItem.findFirstOrThrow({
      where: { refundId: refund.id },
      include: { refund: true },
    });
    expect(withRefund.refund.id).toBe(refund.id);
  });

  it("exposes the reverse OrderItem.refundItems[] list", async () => {
    const { order, item } = await makeOrderWithItem();
    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });
    await prisma.refundItem.create({
      data: { refundId: refund.id, orderItemId: item.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });

    const orderItemWithRefunds = await prisma.orderItem.findUniqueOrThrow({
      where: { id: item.id },
      include: { refundItems: true },
    });
    expect(orderItemWithRefunds.refundItems).toHaveLength(1);
  });

  it("rejects creating a RefundItem against a non-existent Refund or OrderItem (FK enforced)", async () => {
    const { order, item } = await makeOrderWithItem();
    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });

    await expect(
      prisma.refundItem.create({
        data: { refundId: 999_999_999, orderItemId: item.id, amount: new Prisma.Decimal("1.00"), currency: "IDR" },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.refundItem.create({
        data: { refundId: refund.id, orderItemId: 999_999_999, amount: new Prisma.Decimal("1.00"), currency: "IDR" },
      }),
    ).rejects.toThrow();
  });

  it("Restricts (does not cascade) deleting the referenced Refund or OrderItem while a RefundItem exists", async () => {
    const { order, item } = await makeOrderWithItem();
    const refund = await prisma.refund.create({
      data: { orderId: order.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });
    await prisma.refundItem.create({
      data: { refundId: refund.id, orderItemId: item.id, amount: new Prisma.Decimal("5.00"), currency: "IDR" },
    });

    await expect(prisma.refund.delete({ where: { id: refund.id } })).rejects.toThrow();
    await expect(prisma.orderItem.delete({ where: { id: item.id } })).rejects.toThrow();
  });
});
