/**
 * Refund domain crud (Trustance Master Architecture Task 8b): createRefund,
 * listRefunds, transitionRefundStatus's state machine, and
 * createRefundItem's per-order-item sum invariant + currency checks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { RefundStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import {
  createRefund,
  listRefunds,
  transitionRefundStatus,
  createRefundItem,
  REFUND_LEGAL_TRANSITIONS,
} from "./refunds";

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
  const order = await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity });
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order!.id } });
  return { order: order!, item };
}

async function makeAdmin() {
  return prisma.user.create({
    data: { telegramId: Math.floor(Math.random() * 1_000_000_000), username: "admin", fullName: "Admin", role: "ADMIN", referralCode: `a${Math.random()}` },
  });
}

describe("createRefund", () => {
  it("creates a PENDING refund pinned to the order's currency", async () => {
    const { order } = await makeOrderWithItem();

    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: order.currency });

    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(refund.currency).toBe(order.currency);
    expect(refund.amount.toString()).toBe("5");
  });

  it("rejects a currency mismatch against the order's own currency", async () => {
    const { order } = await makeOrderWithItem();
    expect(order.currency).toBe("IDR");

    await expect(
      createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "USDT" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent order", async () => {
    await expect(
      createRefund(prisma, { orderId: 999_999_999, amount: "5.00", currency: "IDR" }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("listRefunds", () => {
  it("filters by orderId and status, newest first, including RefundItem children", async () => {
    const { order: orderA, item: itemA } = await makeOrderWithItem();
    const { order: orderB } = await makeOrderWithItem();

    const refund1 = await createRefund(prisma, { orderId: orderA.id, amount: "1.00", currency: "IDR" });
    await createRefundItem(prisma, { refundId: refund1.id, orderItemId: itemA.id, amount: "1.00" });
    const refund2 = await createRefund(prisma, { orderId: orderA.id, amount: "2.00", currency: "IDR" });
    await createRefund(prisma, { orderId: orderB.id, amount: "3.00", currency: "IDR" });

    const forOrderA = await listRefunds(prisma, { orderId: orderA.id });
    expect(forOrderA.map((r) => r.id).sort()).toEqual([refund1.id, refund2.id].sort());
    const withItems = forOrderA.find((r) => r.id === refund1.id)!;
    expect(withItems.items).toHaveLength(1);

    const pending = await listRefunds(prisma, { status: RefundStatus.PENDING });
    expect(pending.length).toBeGreaterThanOrEqual(3);
  });
});

describe("transitionRefundStatus — state machine", () => {
  it("REFUND_LEGAL_TRANSITIONS encodes exactly the documented shape", () => {
    expect(REFUND_LEGAL_TRANSITIONS[RefundStatus.PENDING]!.slice().sort()).toEqual(
      [RefundStatus.PROCESSING, RefundStatus.CANCELLED].sort(),
    );
    expect(REFUND_LEGAL_TRANSITIONS[RefundStatus.PROCESSING]!.slice().sort()).toEqual(
      [RefundStatus.COMPLETED, RefundStatus.FAILED, RefundStatus.CANCELLED].sort(),
    );
    expect(REFUND_LEGAL_TRANSITIONS[RefundStatus.COMPLETED]).toEqual([]);
    expect(REFUND_LEGAL_TRANSITIONS[RefundStatus.FAILED]).toEqual([]);
    expect(REFUND_LEGAL_TRANSITIONS[RefundStatus.CANCELLED]).toEqual([]);
  });

  it("PENDING -> PROCESSING succeeds, is audited, and does not stamp processedAt", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });

    const result = await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PENDING,
      to: RefundStatus.PROCESSING,
      adminId: admin.id,
    });

    expect(result.status).toBe(RefundStatus.PROCESSING);
    expect(result.processedAt).toBeNull();

    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });
    expect(auditRows).toHaveLength(1);
    const auditRow = auditRows[0]!;
    expect(auditRow.details).toContain("PENDING");
    expect(auditRow.details).toContain("PROCESSING");
    expect(auditRow.details).toContain(order.orderCode);
  });

  it("PROCESSING -> COMPLETED succeeds and stamps processedAt", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    const result = await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.COMPLETED,
      adminId: admin.id,
    });

    expect(result.status).toBe(RefundStatus.COMPLETED);
    expect(result.processedAt).toBeInstanceOf(Date);
  });

  it("PROCESSING -> FAILED succeeds and stamps processedAt", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    const result = await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.FAILED,
      adminId: admin.id,
    });

    expect(result.status).toBe(RefundStatus.FAILED);
    expect(result.processedAt).toBeInstanceOf(Date);
  });

  it("PENDING -> CANCELLED succeeds", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });

    const result = await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PENDING,
      to: RefundStatus.CANCELLED,
      adminId: admin.id,
    });

    expect(result.status).toBe(RefundStatus.CANCELLED);
    expect(result.processedAt).toBeInstanceOf(Date);
  });

  it("PROCESSING -> CANCELLED succeeds", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    const result = await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.CANCELLED,
      adminId: admin.id,
    });

    expect(result.status).toBe(RefundStatus.CANCELLED);
  });

  const illegalCases: Array<[string, string]> = [
    [RefundStatus.PENDING, RefundStatus.COMPLETED],
    [RefundStatus.PENDING, RefundStatus.FAILED],
    [RefundStatus.PROCESSING, RefundStatus.PENDING],
    [RefundStatus.COMPLETED, RefundStatus.PENDING],
    [RefundStatus.COMPLETED, RefundStatus.PROCESSING],
    [RefundStatus.COMPLETED, RefundStatus.CANCELLED],
    [RefundStatus.FAILED, RefundStatus.PENDING],
    [RefundStatus.FAILED, RefundStatus.PROCESSING],
    [RefundStatus.CANCELLED, RefundStatus.PENDING],
    [RefundStatus.CANCELLED, RefundStatus.PROCESSING],
  ];

  it.each(illegalCases)("rejects %s -> %s as illegal", async (from, to) => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });
    // Force the refund into the `from` state directly (bypassing the state
    // machine) so illegal-FROM cases (e.g. COMPLETED -> *) are reachable to test.
    await prisma.refund.update({ where: { id: refund.id }, data: { status: from } });

    await expect(
      transitionRefundStatus(prisma, { refundId: refund.id, from, to, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    // No audit row should have been written for a rejected transition.
    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });
    expect(auditRows).toHaveLength(0);
  });

  it("rejects a transition whose `from` no longer matches the row's actual status (stale claim)", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    // Row is now PROCESSING; claiming PENDING -> PROCESSING again must fail.
    await expect(
      transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects transitioning a non-existent refund", async () => {
    const admin = await makeAdmin();
    await expect(
      transitionRefundStatus(prisma, { refundId: 999_999_999, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("createRefundItem — sum invariant", () => {
  it("accepts an amount within the OrderItem's subtotal", async () => {
    const { order, item } = await makeOrderWithItem(1); // unitPrice 5.00 * qty 1 = 5.00 subtotal
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.00" });

    expect(refundItem.amount.toString()).toBe("5");
    expect(refundItem.currency).toBe("IDR");
  });

  it("accepts several partial RefundItem rows against the same OrderItem as long as their sum stays within the subtotal", async () => {
    // sample.product's unitPrice is 5.00 and createOrderDirect reserves stock
    // per unit for this AUTO SKU, so quantity=2 creates TWO separate OrderItem
    // rows (each quantity:1, subtotal 5.00) rather than one row with
    // quantity:2 — makeOrderWithItem's default (quantity 1) keeps this test
    // pinned to a single item with a 5.00 subtotal.
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "2.00", currency: "IDR" });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "2.00", currency: "IDR" });

    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "2.00" });
    await createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "2.00" });

    const rows = await prisma.refundItem.findMany({ where: { orderItemId: item.id } });
    expect(rows).toHaveLength(2);
  });

  it("rejects a single RefundItem amount that alone exceeds the OrderItem's subtotal", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const refund = await createRefund(prisma, { orderId: order.id, amount: "10.00", currency: "IDR" });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.01" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a RefundItem that would push the cross-refund sum over the subtotal", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR" });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR" });

    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "3.00" });

    // 3.00 already refunded + 3.00 attempted = 6.00 > 5.00 subtotal.
    await expect(
      createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "3.00" }),
    ).rejects.toThrow(ValidationError);

    // The second (rejected) RefundItem must not have been persisted.
    const rows = await prisma.refundItem.findMany({ where: { orderItemId: item.id } });
    expect(rows).toHaveLength(1);
  });

  it("allows a RefundItem that exactly matches the remaining subtotal (boundary, not strictly-less)", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "2.00", currency: "IDR" });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR" });
    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "2.00" });

    const refundItem = await createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "3.00" });
    expect(refundItem.amount.toString()).toBe("3");
  });

  it("derives RefundItem.currency from the parent Refund, not a caller-supplied value", async () => {
    const { order, item } = await makeOrderWithItem();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR" });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.00" });
    expect(refundItem.currency).toBe(refund.currency);
  });

  it("rejects a non-existent refund", async () => {
    const { item } = await makeOrderWithItem();
    await expect(
      createRefundItem(prisma, { refundId: 999_999_999, orderItemId: item.id, amount: "1.00" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent order item", async () => {
    const { order } = await makeOrderWithItem();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "1.00", currency: "IDR" });
    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: 999_999_999, amount: "1.00" }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an OrderItem that belongs to a different order than the Refund's own order", async () => {
    const { order: orderA } = await makeOrderWithItem();
    const { item: itemB } = await makeOrderWithItem();
    const refund = await createRefund(prisma, { orderId: orderA.id, amount: "1.00", currency: "IDR" });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: itemB.id, amount: "1.00" }),
    ).rejects.toThrow(ValidationError);
  });
});
