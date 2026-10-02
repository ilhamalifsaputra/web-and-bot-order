/**
 * Refund domain crud (Trustance Master Architecture Task 8b): createRefund,
 * listRefunds, transitionRefundStatus's state machine, and
 * createRefundItem's per-order-item sum invariant + currency checks.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { RefundExecutionMethod, RefundExecutionStatus, RefundStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import { adjustWallet } from "./users";
import {
  createRefund,
  executeRefund,
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
  const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity });
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
    const admin = await makeAdmin();

    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: order.currency, adminId: admin.id });

    expect(refund.status).toBe(RefundStatus.PENDING);
    expect(refund.currency).toBe(order.currency);
    expect(refund.amount.toString()).toBe("5");
  });

  it("audits the creation with the acting admin id", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();

    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: order.currency, adminId: admin.id });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_created", targetId: refund.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBe(admin.id);
    expect(auditRows[0]!.details).toContain(order.orderCode);
    expect(auditRows[0]!.details).toContain("5");
  });

  it("rejects a currency mismatch against the order's own currency", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    expect(order.currency).toBe("IDR");

    await expect(
      createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "USDT", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent order", async () => {
    const admin = await makeAdmin();
    await expect(
      createRefund(prisma, { orderId: 999_999_999, amount: "5.00", currency: "IDR", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a zero amount", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    await expect(
      createRefund(prisma, { orderId: order.id, amount: "0", currency: order.currency, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a negative amount", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    await expect(
      createRefund(prisma, { orderId: order.id, amount: "-5.00", currency: order.currency, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a malformed amount string as a clean ValidationError, not a raw DecimalError", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    await expect(
      createRefund(prisma, { orderId: order.id, amount: "not-a-number", currency: order.currency, adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("listRefunds", () => {
  it("filters by orderId and status, newest first, including RefundItem children", async () => {
    const { order: orderA, item: itemA } = await makeOrderWithItem();
    const { order: orderB } = await makeOrderWithItem();
    const admin = await makeAdmin();

    const refund1 = await createRefund(prisma, { orderId: orderA.id, amount: "1.00", currency: "IDR", adminId: admin.id });
    await createRefundItem(prisma, { refundId: refund1.id, orderItemId: itemA.id, amount: "1.00", adminId: admin.id });
    const refund2 = await createRefund(prisma, { orderId: orderA.id, amount: "2.00", currency: "IDR", adminId: admin.id });
    await createRefund(prisma, { orderId: orderB.id, amount: "3.00", currency: "IDR", adminId: admin.id });

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
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

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
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    const result = await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.COMPLETED,
      adminId: admin.id,
      acknowledgeNoPayout: true,
    });

    expect(result.status).toBe(RefundStatus.COMPLETED);
    expect(result.processedAt).toBeInstanceOf(Date);
  });

  it("rejects PROCESSING -> COMPLETED without acknowledgeNoPayout", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    const auditRowsBefore = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });

    await expect(
      transitionRefundStatus(prisma, {
        refundId: refund.id,
        from: RefundStatus.PROCESSING,
        to: RefundStatus.COMPLETED,
        adminId: admin.id,
      }),
    ).rejects.toThrow(ValidationError);

    // No NEW audit row should have been written for the rejected COMPLETED
    // attempt (the PENDING -> PROCESSING transition above legitimately wrote
    // its own audit row already, so the assertion is "count unchanged", not
    // "count is zero").
    const auditRowsAfter = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });
    expect(auditRowsAfter).toHaveLength(auditRowsBefore.length);
  });

  it("a COMPLETED transition's audit entry states it is record-keeping only", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.COMPLETED,
      adminId: admin.id,
      acknowledgeNoPayout: true,
    });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });
    const completedRow = auditRows.find((r) => (r.details ?? "").includes("PROCESSING") && (r.details ?? "").includes("COMPLETED"))!;
    expect(completedRow.details).toContain("Record-keeping only — no payout was triggered");
  });

  it("a COMPLETED transition beside a real payout says the buyer WAS paid, and names the execution", async () => {
    // The `executeRefund` shape: the payout is made and the RefundExecution row
    // written BEFORE the transition closes the record, in the same transaction.
    // The row is inserted directly here because what is under test is the
    // sentence this function chooses, not the payout stack that produces the row
    // (refundExecution.test.ts covers the integrated path). Telling a shop admin
    // "record-keeping only — no payout was triggered" beside a wallet credit the
    // buyer has already received reads as "they have NOT been paid", which is the
    // opposite of the truth.
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });
    const execution = await prisma.refundExecution.create({
      data: {
        refundId: refund.id,
        method: RefundExecutionMethod.WALLET,
        amount: "5.00",
        currency: "IDR",
        status: RefundExecutionStatus.COMPLETED,
        executedBy: admin.id,
        executedAt: new Date(),
      },
    });

    await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.COMPLETED,
      adminId: admin.id,
      acknowledgeNoPayout: true,
    });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });
    const completedRow = auditRows.find((r) => (r.details ?? "").includes("PROCESSING") && (r.details ?? "").includes("COMPLETED"))!;
    expect(completedRow.details).toContain("The buyer has been paid");
    expect(completedRow.details).toContain(`refund execution #${execution.id}`);
    expect(completedRow.details).not.toContain("no payout was triggered");
  });

  it("ignores a FAILED execution when wording the COMPLETED line — a bounced transfer paid nobody", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });
    await prisma.refundExecution.create({
      data: {
        refundId: refund.id,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
        amount: "5.00",
        currency: "IDR",
        status: RefundExecutionStatus.FAILED,
        executedBy: admin.id,
        executedAt: new Date(),
      },
    });

    await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PROCESSING,
      to: RefundStatus.COMPLETED,
      adminId: admin.id,
      acknowledgeNoPayout: true,
    });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_status_change", targetId: refund.id } });
    const completedRow = auditRows.find((r) => (r.details ?? "").includes("PROCESSING") && (r.details ?? "").includes("COMPLETED"))!;
    expect(completedRow.details).toContain("Record-keeping only — no payout was triggered");
  });

  it("PROCESSING -> FAILED succeeds and stamps processedAt", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
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
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

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
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
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
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
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
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
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
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });

    expect(refundItem.amount.toString()).toBe("5");
    expect(refundItem.currency).toBe("IDR");
  });

  it("audits the creation with the acting admin id", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "refund_item_created", targetId: refundItem.id } });
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.adminId).toBe(admin.id);
  });

  it("accepts several partial RefundItem rows against the same OrderItem as long as their sum stays within the subtotal", async () => {
    // sample.product's unitPrice is 5.00 and createOrderDirect reserves stock
    // per unit for this AUTO SKU, so quantity=2 creates TWO separate OrderItem
    // rows (each quantity:1, subtotal 5.00) rather than one row with
    // quantity:2 — makeOrderWithItem's default (quantity 1) keeps this test
    // pinned to a single item with a 5.00 subtotal.
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "2.00", currency: "IDR", adminId: admin.id });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "2.00", currency: "IDR", adminId: admin.id });

    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "2.00", adminId: admin.id });
    await createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "2.00", adminId: admin.id });

    const rows = await prisma.refundItem.findMany({ where: { orderItemId: item.id } });
    expect(rows).toHaveLength(2);
  });

  it("rejects a single RefundItem amount that alone exceeds the OrderItem's subtotal", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "10.00", currency: "IDR", adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.01", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a RefundItem that would push the cross-refund sum over the subtotal", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR", adminId: admin.id });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR", adminId: admin.id });

    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "3.00", adminId: admin.id });

    // 3.00 already refunded + 3.00 attempted = 6.00 > 5.00 subtotal.
    await expect(
      createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "3.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    // The second (rejected) RefundItem must not have been persisted.
    const rows = await prisma.refundItem.findMany({ where: { orderItemId: item.id } });
    expect(rows).toHaveLength(1);
  });

  it("allows a RefundItem that exactly matches the remaining subtotal (boundary, not strictly-less)", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "2.00", currency: "IDR", adminId: admin.id });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR", adminId: admin.id });
    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "2.00", adminId: admin.id });

    const refundItem = await createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "3.00", adminId: admin.id });
    expect(refundItem.amount.toString()).toBe("3");
  });

  it("derives RefundItem.currency from the parent Refund, not a caller-supplied value", async () => {
    const { order, item } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });
    expect(refundItem.currency).toBe(refund.currency);
  });

  it("rejects a non-existent refund", async () => {
    const { item } = await makeOrderWithItem();
    const admin = await makeAdmin();
    await expect(
      createRefundItem(prisma, { refundId: 999_999_999, orderItemId: item.id, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a non-existent order item", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "1.00", currency: "IDR", adminId: admin.id });
    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: 999_999_999, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an OrderItem that belongs to a different order than the Refund's own order", async () => {
    const { order: orderA } = await makeOrderWithItem();
    const { item: itemB } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: orderA.id, amount: "1.00", currency: "IDR", adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: itemB.id, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("releases the item's refund budget after the consuming Refund is CANCELLED", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });

    await transitionRefundStatus(prisma, {
      refundId: refundA.id,
      from: RefundStatus.PENDING,
      to: RefundStatus.CANCELLED,
      adminId: admin.id,
    });

    // The full subtotal should be refundable again, since refundA never
    // actually paid out anything.
    const refundB = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    const refundItemB = await createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });
    expect(refundItemB.amount.toString()).toBe("5");
  });

  it("releases the item's refund budget after the consuming Refund FAILs", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refundA.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refundA.id, from: RefundStatus.PROCESSING, to: RefundStatus.FAILED, adminId: admin.id });

    const refundB = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    const refundItemB = await createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });
    expect(refundItemB.amount.toString()).toBe("5");
  });

  it("still counts a COMPLETED refund's RefundItem amount against the budget (does not release it)", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refundA = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refundA.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refundA.id, from: RefundStatus.PROCESSING, to: RefundStatus.COMPLETED, adminId: admin.id, acknowledgeNoPayout: true });

    const refundB = await createRefund(prisma, { orderId: order.id, amount: "1.00", currency: "IDR", adminId: admin.id });
    await expect(
      createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("createRefundItem — Refund.amount invariant", () => {
  it("rejects a RefundItem that would push this refund's own item total over Refund.amount", async () => {
    // subtotal 5.00 — comfortably larger than the Refund.amount (3.00) used
    // below, so the item's own subtotal is never the binding constraint here.
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR", adminId: admin.id });

    await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "2.00", adminId: admin.id });

    // 2.00 already on this refund + 2.00 attempted = 4.00, which is > this
    // refund's own 3.00 amount, but still comfortably under the item's 5.00
    // subtotal — the pre-existing cross-refund subtotal check would NOT
    // reject this on its own; only the new per-refund invariant does.
    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "2.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    const rows = await prisma.refundItem.findMany({ where: { refundId: refund.id } });
    expect(rows).toHaveLength(1);
  });

  it("allows a RefundItem that exactly matches the remaining Refund.amount (boundary)", async () => {
    const { order, item } = await makeOrderWithItem(1); // subtotal 5.00
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "3.00", currency: "IDR", adminId: admin.id });

    await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "2.00", adminId: admin.id });

    // 2.00 already on this refund + 1.00 attempted = exactly 3.00, matching
    // Refund.amount exactly — not strictly-less, must still succeed.
    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "1.00", adminId: admin.id });
    expect(refundItem.amount.toString()).toBe("1");

    const rows = await prisma.refundItem.findMany({ where: { refundId: refund.id } });
    expect(rows).toHaveLength(2);
  });
});

describe("createRefundItem — amount validation", () => {
  it("rejects a zero amount", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "0", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a negative amount (which would otherwise shrink the already-refunded sum and let a later item overrun the subtotal)", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "-1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a malformed amount string as a clean ValidationError, not a raw DecimalError", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "not-a-number", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("still accepts a normal positive amount", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "5.00", adminId: admin.id });
    expect(refundItem.amount.toString()).toBe("5");
  });
});

describe("createRefundItem — rejects attaching to a terminal Refund", () => {
  it("rejects adding an item to a COMPLETED refund", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PROCESSING, to: RefundStatus.COMPLETED, adminId: admin.id, acknowledgeNoPayout: true });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    const rows = await prisma.refundItem.findMany({ where: { refundId: refund.id } });
    expect(rows).toHaveLength(0);
  });

  it("rejects adding an item to a CANCELLED refund", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.CANCELLED, adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);

    const rows = await prisma.refundItem.findMany({ where: { refundId: refund.id } });
    expect(rows).toHaveLength(0);
  });

  it("rejects adding an item to a FAILED refund", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PROCESSING, to: RefundStatus.FAILED, adminId: admin.id });

    await expect(
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "1.00", adminId: admin.id }),
    ).rejects.toThrow(ValidationError);
  });

  it("still allows adding an item to a PENDING or PROCESSING refund", async () => {
    const { order, item } = await makeOrderWithItem(1);
    const admin = await makeAdmin();
    const refund = await createRefund(prisma, { orderId: order.id, amount: "5.00", currency: "IDR", adminId: admin.id });
    await transitionRefundStatus(prisma, { refundId: refund.id, from: RefundStatus.PENDING, to: RefundStatus.PROCESSING, adminId: admin.id });

    const refundItem = await createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: "1.00", adminId: admin.id });
    expect(refundItem.amount.toString()).toBe("1");
  });
});

/**
 * `executeRefund`'s ORDER-level refundable ceiling (whole-branch review decision
 * D4).
 *
 * Three different code paths give money back to a buyer for one order, built at
 * different times, and the ceiling originally counted only the newest of them. An
 * order already refunded through either of the other two could therefore be paid
 * out AGAIN for its whole value — a buyer keeps what they were given and is paid
 * the total on top of it.
 *
 * Not reachable through the routes shipped today (`executeRefund`'s only
 * production caller requires a DELIVERED order, and both other paths leave the
 * order elsewhere), which is exactly why it needs tests rather than a note: the
 * guard is invisible until a generic admin refund route exists, and by then
 * nobody will re-derive it.
 */
describe("executeRefund — the refundable ceiling counts every way money went back", () => {
  /** A PROCESSING refund — the only state `executeRefund` accepts. */
  async function makeProcessingRefund(orderId: number, amount: Decimal.Value, adminId: number) {
    const refund = await createRefund(prisma, { orderId, amount, currency: "IDR", adminId });
    await transitionRefundStatus(prisma, {
      refundId: refund.id,
      from: RefundStatus.PENDING,
      to: RefundStatus.PROCESSING,
      adminId,
    });
    return refund;
  }

  /**
   * The row `refundUnderpaidOrder` (crud/binance_internal.ts) writes: an
   * already-COMPLETED `Refund` with NO `RefundExecution`, created directly rather
   * than through the state machine. Written the same way here, because the shape
   * is the whole point — it is what the ceiling has to notice.
   */
  async function makeLegacyCompletedRefund(orderId: number, amount: string) {
    return prisma.refund.create({
      data: {
        orderId,
        amount,
        currency: "IDR",
        status: RefundStatus.COMPLETED,
        processedAt: new Date(),
      },
    });
  }

  /** An order's total, quantized the way the ceiling compares it. */
  const totalOf = (order: { totalAmount: Decimal.Value }) => new Decimal(order.totalAmount);

  it("refuses a payout on an order already refunded through the underpaid path", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    await makeLegacyCompletedRefund(order.id, totalOf(order).toString());
    const refund = await makeProcessingRefund(order.id, "1.00", admin.id);

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.WALLET,
        amount: "1.00",
        executedBy: admin.id,
      }),
    ).rejects.toMatchObject({ key: "error.refund_exceeds_refundable_amount" });

    // Nothing recorded and nothing paid: the refund stays PROCESSING and the
    // buyer's balance is untouched.
    expect(await prisma.refundExecution.count({ where: { refundId: refund.id } })).toBe(0);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(buyer.walletBalance.toString()).toBe("0");
  });

  it("refuses a payout on an order already credited back as wallet balance", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    // What `creditOrderToBalance` (crud/orders.ts) writes: an
    // `unfulfilled_credit` movement against the order, and NO Refund row at all,
    // so neither refund-shaped read can see it.
    await adjustWallet(prisma, sample.user.id, totalOf(order), {
      reason: "unfulfilled_credit",
      currency: "IDR",
      orderId: order.id,
      adminId: admin.id,
    });
    const refund = await makeProcessingRefund(order.id, "1.00", admin.id);

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.WALLET,
        amount: "1.00",
        executedBy: admin.id,
      }),
    ).rejects.toMatchObject({ key: "error.refund_exceeds_refundable_amount" });
    expect(await prisma.refundExecution.count({ where: { refundId: refund.id } })).toBe(0);
  });

  it("leaves exactly the remainder refundable after a partial underpaid refund", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const remainder = totalOf(order).minus("2.00");
    await makeLegacyCompletedRefund(order.id, "2.00");

    // One cent more than the remainder is refused...
    const tooMuch = await makeProcessingRefund(order.id, remainder.plus("0.01"), admin.id);
    await expect(
      executeRefund(prisma, {
        refundId: tooMuch.id,
        method: RefundExecutionMethod.WALLET,
        amount: remainder.plus("0.01"),
        executedBy: admin.id,
      }),
    ).rejects.toMatchObject({ key: "error.refund_exceeds_refundable_amount" });

    // ...and exactly the remainder is allowed. A ceiling that only ever refused
    // would pass the two cases above for the wrong reason.
    const exact = await makeProcessingRefund(order.id, remainder, admin.id);
    const execution = await executeRefund(prisma, {
      refundId: exact.id,
      method: RefundExecutionMethod.WALLET,
      amount: remainder,
      executedBy: admin.id,
    });
    expect(execution.amount.toString()).toBe(remainder.toString());
  });

  it("counts a refund with a COMPLETED execution once, not twice", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    const first = await makeProcessingRefund(order.id, "2.00", admin.id);
    await executeRefund(prisma, {
      refundId: first.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: admin.id,
    });

    // That refund is now COMPLETED *and* has a COMPLETED execution, so it matches
    // the execution read — and must NOT also match the "no execution at all" read,
    // or 2.00 would be deducted twice and the remainder would be short.
    const remainder = totalOf(order).minus("2.00");
    const second = await makeProcessingRefund(order.id, remainder, admin.id);
    const execution = await executeRefund(prisma, {
      refundId: second.id,
      method: RefundExecutionMethod.WALLET,
      amount: remainder,
      executedBy: admin.id,
    });

    expect(execution.amount.toString()).toBe(remainder.toString());
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(buyer.walletBalance.toString()).toBe(totalOf(order).toString());
  });

  it("ignores an unfulfilled_credit movement in another currency", async () => {
    const { order } = await makeOrderWithItem();
    const admin = await makeAdmin();
    // IDR and USDT are unconvertible here, so a USDT credit says nothing about
    // how much of an IDR order has been given back — deducting it would be a
    // meaningless number, not a conservative one.
    await adjustWallet(prisma, sample.user.id, totalOf(order), {
      reason: "unfulfilled_credit",
      currency: "USDT",
      orderId: order.id,
      adminId: admin.id,
    });
    const refund = await makeProcessingRefund(order.id, "1.00", admin.id);

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "1.00",
      executedBy: admin.id,
    });
    expect(execution.amount.toString()).toBe("1");
  });
});
