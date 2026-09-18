/**
 * Account/stock replacement (reissue) service — Financial Ledger M19.
 *
 * Covers the two sanctioned mutators (`replaceStockItem`,
 * `refundInsteadOfReplace`), the `retryReplacementAllocation` resume path that
 * unblocks an AWAITING_STOCK request once a restock lands, the transition
 * table they all enforce, and the refund fallback's money movement — which is
 * this codebase's FIRST production use of `createRefund`/`createRefundItem`
 * and pays out through the existing `executeRefund` ledger path.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  NotificationEvent,
  OrderStatus,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
  StockReplacementStatus,
  StockStatus,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { approveOrder, attachPaymentProof, createOrderDirect, getOrder } from "./orders";
import { bulkAddStock } from "./stock";
import {
  STOCK_REPLACEMENT_LEGAL_TRANSITIONS,
  listStockReplacementsForOrder,
  refundInsteadOfReplace,
  replaceStockItem,
  retryReplacementAllocation,
} from "./stockReplacement";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let adminId: number;

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
  const admin = await prisma.user.create({
    data: {
      telegramId: 777001,
      username: "admin",
      fullName: "Admin",
      role: "ADMIN",
      referralCode: `a${Math.random()}`,
    },
  });
  adminId = admin.id;
});

/** A DELIVERED order with `quantity` units, each holding its own SOLD StockItem. */
async function makeDeliveredOrder(quantity = 1, voucherCode?: string) {
  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const created = await createOrderDirect(prisma, {
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: sample.product.id,
    quantity,
    voucherCode: voucherCode ?? null,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  await approveOrder(prisma, created!.id, { adminId });
  // approveOrder enqueues its own delivery rows; clear them so each test can
  // assert on exactly what the replacement itself enqueued.
  await prisma.notificationOutbox.deleteMany();
  // The shared fixture seeds 5 credentials, so a 1-unit order would leave 4
  // spares lying around and every request would silently find one. Drain them,
  // making "there is nothing to replace it with" the default and `restock()`
  // the explicit opt-in — which is the state most of this file is about.
  await prisma.stockItem.deleteMany({
    where: { productId: sample.product.id, status: StockStatus.AVAILABLE },
  });
  const order = (await getOrder(prisma, created!.id))!;
  const items = await prisma.orderItem.findMany({
    where: { orderId: order.id },
    orderBy: { id: "asc" },
  });
  return { order, items };
}

/** Top the sample SKU back up so a replacement has something to allocate. */
async function restock(count = 1) {
  await bulkAddStock(
    prisma,
    sample.product.id,
    Array.from({ length: count }, () => `spare-${Math.random()}@example.com:pwd`),
  );
}

describe("STOCK_REPLACEMENT_LEGAL_TRANSITIONS", () => {
  it("encodes exactly the documented shape — four terminal values with no outgoing edges", () => {
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.REQUESTED]!.slice().sort()).toEqual(
      [
        StockReplacementStatus.AWAITING_STOCK,
        StockReplacementStatus.COMPLETED,
        StockReplacementStatus.CANCELLED,
        StockReplacementStatus.FAILED,
      ].sort(),
    );
    expect(
      STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.AWAITING_STOCK]!.slice().sort(),
    ).toEqual(
      [
        StockReplacementStatus.COMPLETED,
        StockReplacementStatus.REFUNDED_INSTEAD,
        StockReplacementStatus.CANCELLED,
        StockReplacementStatus.FAILED,
      ].sort(),
    );
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.COMPLETED]).toEqual([]);
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.REFUNDED_INSTEAD]).toEqual([]);
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.CANCELLED]).toEqual([]);
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.FAILED]).toEqual([]);
  });

  it("never offers REFUNDED_INSTEAD from REQUESTED — only a supply-blocked request may be refunded instead", () => {
    expect(STOCK_REPLACEMENT_LEGAL_TRANSITIONS[StockReplacementStatus.REQUESTED]).not.toContain(
      StockReplacementStatus.REFUNDED_INSTEAD,
    );
  });
});

describe("replaceStockItem — replacement stock available", () => {
  it("swaps the credential: original DEAD, a new SOLD row on the order item, request COMPLETED", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const item = items[0]!;
    const originalStockId = item.stockItemId!;
    await restock(1);

    const { replacement, replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: item.id,
      reason: "password changed by the account owner",
      executedBy: adminId,
    });

    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);
    expect(replacement.resolvedAt).not.toBeNull();
    expect(replacement.originalStockItemId).toBe(originalStockId);
    expect(replacement.replacementStockItemId).toBe(replacementStockItem!.id);
    expect(replacement.refundId).toBeNull();
    expect(replacement.requestedBy).toBe(adminId);
    expect(replacement.reason).toBe("password changed by the account owner");

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);
    expect(original.note).toContain(String(replacement.id));

    const fresh = await prisma.stockItem.findUniqueOrThrow({ where: { id: replacementStockItem!.id } });
    expect(fresh.status).toBe(StockStatus.SOLD);
    expect(fresh.soldAt).not.toBeNull();
    expect(fresh.orderId).toBe(order.id);

    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(reloadedItem.stockItemId).toBe(replacementStockItem!.id);
  });

  it("redelivers through the notification outbox, the same ORDER_DELIVERED_DM row the resend path enqueues", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "account banned within 24h",
      executedBy: adminId,
    });

    const queued = await prisma.notificationOutbox.findMany({ where: { orderId: order.id } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.event).toBe(NotificationEvent.ORDER_DELIVERED_DM);
    const payload = JSON.parse(queued[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.chat_id).toBe(Number(sample.user.telegramId));
    // The credential itself never rides in the payload — the dispatcher reads
    // it live, which is exactly why repointing the OrderItem redelivers the
    // NEW account (CLAUDE.md: never log/queue secrets).
    expect(queued[0]!.payloadJson).not.toContain("user1@example.com");
  });

  it("audits the swap with the acting admin id, in plain language naming the order", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "invalid credentials",
      executedBy: adminId,
    });

    const rows = await prisma.auditLog.findMany({
      where: { targetType: "stock_replacement", targetId: replacement.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
    expect(rows[0]!.details).toContain(order.orderCode);
    expect(rows[0]!.details).not.toContain("=");
  });

  it("leaves every other unit of a bulk order completely untouched", async () => {
    const { items } = await makeDeliveredOrder(5);
    const target = items[0]!;
    const others = items.slice(1);
    const othersBefore = await prisma.stockItem.findMany({
      where: { id: { in: others.map((o) => o.stockItemId!) } },
      orderBy: { id: "asc" },
    });
    await restock(1);

    await replaceStockItem(prisma, {
      orderItemId: target.id,
      reason: "one of five is dead",
      executedBy: adminId,
    });

    const othersAfter = await prisma.orderItem.findMany({
      where: { id: { in: others.map((o) => o.id) } },
      orderBy: { id: "asc" },
    });
    expect(othersAfter.map((o) => o.stockItemId)).toEqual(others.map((o) => o.stockItemId));

    const stockAfter = await prisma.stockItem.findMany({
      where: { id: { in: others.map((o) => o.stockItemId!) } },
      orderBy: { id: "asc" },
    });
    expect(stockAfter).toEqual(othersBefore);

    expect(await prisma.stockReplacement.count()).toBe(1);
  });
});

describe("replaceStockItem — no replacement stock", () => {
  it("parks the request at AWAITING_STOCK, unresolved, with the original still DEAD", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const originalStockId = items[0]!.stockItemId!;

    const { replacement, replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead on arrival",
      executedBy: adminId,
    });

    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(replacement.resolvedAt).toBeNull();
    expect(replacement.replacementStockItemId).toBeNull();
    expect(replacementStockItem).toBeNull();

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);

    // Nothing was redelivered — there is nothing to deliver yet.
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(0);
  });
});

describe("replaceStockItem — guards", () => {
  it("refuses an order that is not DELIVERED", async () => {
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const created = await createOrderDirect(prisma, {
      user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
      productId: sample.product.id,
      quantity: 1,
    });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id } });
    expect((await getOrder(prisma, created!.id))!.status).not.toBe(OrderStatus.DELIVERED);

    await expect(
      replaceStockItem(prisma, { orderItemId: item.id, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an order item whose stock row is not SOLD", async () => {
    const { items } = await makeDeliveredOrder(1);
    await prisma.stockItem.update({
      where: { id: items[0]!.stockItemId! },
      data: { status: StockStatus.DEAD },
    });

    await expect(
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an order item with no stock row at all", async () => {
    const { items } = await makeDeliveredOrder(1);
    await prisma.orderItem.update({ where: { id: items[0]!.id }, data: { stockItemId: null } });

    await expect(
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an unknown order item", async () => {
    await expect(
      replaceStockItem(prisma, { orderItemId: 999_999_999, reason: "x", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses a second request while one is still open (non-terminal) for the same unit", async () => {
    const { items } = await makeDeliveredOrder(1);
    const first = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(first.replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);

    await expect(
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "dead again", executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.stockReplacement.count()).toBe(1);
  });

  it("allows a fresh request once an earlier one reached a terminal status", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(2);
    const first = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(first.replacement.status).toBe(StockReplacementStatus.COMPLETED);

    const second = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "the replacement was dead too",
      executedBy: adminId,
    });
    expect(second.replacement.status).toBe(StockReplacementStatus.COMPLETED);
    expect(second.replacement.originalStockItemId).toBe(first.replacement.replacementStockItemId);
  });

  it("lets exactly one of two CONCURRENT requests for the same unit through", async () => {
    // No spare stock on purpose: the winner parks at AWAITING_STOCK, which is
    // NON-terminal, so the loser must meet the open-request guard. (With spare
    // stock the winner would resolve COMPLETED and the second call would be a
    // legitimate fresh request against the replacement — covered above.)
    const { items } = await makeDeliveredOrder(1);

    const results = await Promise.allSettled([
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "a", executedBy: adminId }),
      replaceStockItem(prisma, { orderItemId: items[0]!.id, reason: "b", executedBy: adminId }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    // The loser must be turned away by the open-request guard specifically —
    // not by a deadlock, a lock timeout or any other incidental error that
    // would happen to look the same from outside.
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(ValidationError);
    expect((loser.reason as ValidationError).key).toBe("error.stock_replacement_already_open");
    expect(await prisma.stockReplacement.count()).toBe(1);
    // And the loser's whole transaction rolled back: the delivered credential
    // was retired exactly once, by the winner.
    expect(
      await prisma.stockItem.count({
        where: { productId: sample.product.id, status: StockStatus.DEAD },
      }),
    ).toBe(1);
  });
});

describe("retryReplacementAllocation", () => {
  it("completes an AWAITING_STOCK request once the SKU is restocked", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    await restock(1);

    const retried = await retryReplacementAllocation(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(retried.replacement.status).toBe(StockReplacementStatus.COMPLETED);
    expect(retried.replacement.resolvedAt).not.toBeNull();
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: items[0]!.id } });
    expect(reloadedItem.stockItemId).toBe(retried.replacementStockItem!.id);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("leaves the request AWAITING_STOCK when there is still nothing to allocate", async () => {
    const { items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const retried = await retryReplacementAllocation(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(retried.replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(retried.replacementStockItem).toBeNull();
  });

  it("refuses a request that is not AWAITING_STOCK", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);

    await expect(
      retryReplacementAllocation(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("listStockReplacementsForOrder", () => {
  it("returns nothing for an order no unit of which was ever complained about", async () => {
    const { order } = await makeDeliveredOrder(2);
    expect(await listStockReplacementsForOrder(prisma, order.id)).toEqual([]);
  });

  it("returns every unit's requests oldest-first, and only this order's", async () => {
    const mine = await makeDeliveredOrder(2);
    const first = await replaceStockItem(prisma, {
      orderItemId: mine.items[0]!.id,
      reason: "unit one is dead",
      executedBy: adminId,
    });
    const second = await replaceStockItem(prisma, {
      orderItemId: mine.items[1]!.id,
      reason: "unit two is dead too",
      executedBy: adminId,
    });
    // A second order's request must not leak into the first order's list.
    // `makeDeliveredOrder` drains the SKU's spares, so top it back up first or
    // this second order can't be checked out at all.
    await restock(1);
    const other = await makeDeliveredOrder(1);
    await replaceStockItem(prisma, {
      orderItemId: other.items[0]!.id,
      reason: "someone else's problem",
      executedBy: adminId,
    });

    const rows = await listStockReplacementsForOrder(prisma, mine.order.id);

    expect(rows.map((r) => r.id)).toEqual([first.replacement.id, second.replacement.id]);
    expect(rows.map((r) => r.orderItemId)).toEqual([mine.items[0]!.id, mine.items[1]!.id]);
    expect(rows[0]!.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(rows[0]!.reason).toBe("unit one is dead");
    expect(rows[0]!.refund).toBeNull();
  });

  it("attaches the refund a REFUNDED_INSTEAD request paid out, so a reader can show the amount", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "nothing to replace it with",
      executedBy: adminId,
    });
    const { refund } = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const rows = await listStockReplacementsForOrder(prisma, order.id);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe(StockReplacementStatus.REFUNDED_INSTEAD);
    expect(rows[0]!.resolvedAt).not.toBeNull();
    expect(rows[0]!.refund!.id).toBe(refund.id);
    expect(new Decimal(rows[0]!.refund!.amount).equals(new Decimal(items[0]!.unitPrice))).toBe(true);
    expect(rows[0]!.refund!.currency).toBe(order.currency);
  });

  it("names the replacement credential a COMPLETED request handed over, but never the credential itself", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement, replacementStockItem } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const rows = await listStockReplacementsForOrder(prisma, order.id);

    expect(rows[0]!.status).toBe(StockReplacementStatus.COMPLETED);
    expect(rows[0]!.replacementStockItemId).toBe(replacementStockItem!.id);
    expect(rows[0]!.id).toBe(replacement.id);
    // A reader gets ids and money, never the account itself — the delivered
    // credential reaches the buyer through the outbox and nowhere else.
    expect(JSON.stringify(rows)).not.toContain("@example.com");
  });
});

describe("refundInsteadOfReplace", () => {
  async function awaitingStockRequest(quantity = 1, voucherCode?: string) {
    const { order, items } = await makeDeliveredOrder(quantity, voucherCode);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "no stock to replace it with",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    return { order, items, replacement };
  }

  it("pays the unit back to the buyer's wallet and closes the request REFUNDED_INSTEAD", async () => {
    const { order, items, replacement } = await awaitingStockRequest(1);
    const unitPrice = new Decimal(items[0]!.unitPrice);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(result.replacement.status).toBe(StockReplacementStatus.REFUNDED_INSTEAD);
    expect(result.replacement.resolvedAt).not.toBeNull();
    expect(result.replacement.refundId).toBe(result.refund.id);
    expect(result.replacement.replacementStockItemId).toBeNull();

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.status).toBe(RefundStatus.COMPLETED);
    expect(refunds[0]!.currency).toBe(order.currency);
    expect(new Decimal(refunds[0]!.amount).equals(unitPrice)).toBe(true);

    const refundItems = await prisma.refundItem.findMany({ where: { refundId: result.refund.id } });
    expect(refundItems).toHaveLength(1);
    expect(refundItems[0]!.orderItemId).toBe(items[0]!.id);
    expect(new Decimal(refundItems[0]!.amount).equals(unitPrice)).toBe(true);

    const executions = await prisma.refundExecution.findMany({ where: { refundId: result.refund.id } });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe(RefundExecutionStatus.COMPLETED);
    expect(executions[0]!.method).toBe(RefundExecutionMethod.WALLET);
    expect(new Decimal(executions[0]!.amount).equals(unitPrice)).toBe(true);

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(unitPrice)).toBe(true);
  });

  it("posts the payout to the double-entry ledger through the existing executeRefund path", async () => {
    const { replacement } = await awaitingStockRequest(1);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const posting = await prisma.financialTransaction.findFirstOrThrow({
      where: { referenceType: "refund_execution" },
    });
    const entries = await prisma.ledgerEntry.findMany({
      where: { financialTransactionId: posting.id },
    });
    expect(entries.length).toBeGreaterThan(0);
    const debits = entries
      .filter((e) => e.direction === "DEBIT")
      .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
    const credits = entries
      .filter((e) => e.direction === "CREDIT")
      .reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
    expect(debits.equals(credits)).toBe(true);
    expect(new Decimal(result.execution.amount).greaterThan(0)).toBe(true);
  });

  it("leaves the original credential DEAD — the buyer's money back does not revive it", async () => {
    const { items, replacement } = await awaitingStockRequest(1);
    const originalStockId = replacement.originalStockItemId;
    expect(originalStockId).toBe(items[0]!.stockItemId);

    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);
  });

  it("refunds one unit of a five-unit order without touching the other four", async () => {
    const { order, items, replacement } = await awaitingStockRequest(5);
    const unitPrice = new Decimal(items[0]!.unitPrice);

    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    expect(await prisma.refundItem.count()).toBe(1);
    // A single-unit refund must NOT flip a multi-unit order to REFUNDED.
    const reloaded = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reloaded.status).toBe(OrderStatus.DELIVERED);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(unitPrice)).toBe(true);
  });

  it("refunds the unit NET of its prorated share of an order-level voucher discount", async () => {
    const { items, replacement } = await awaitingStockRequest(2, "SAVE10");
    // 2 x 5.00 = 10.00 subtotal, 10% voucher = 1.00 off, so each unit is worth
    // 5.00 - (1.00 x 5.00/10.00) = 4.50 of what the buyer actually paid.
    const expected = new Decimal("4.5");
    expect(new Decimal(items[0]!.unitPrice).equals(new Decimal("5"))).toBe(true);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    expect(new Decimal(result.execution.amount).equals(expected)).toBe(true);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(expected)).toBe(true);
  });

  it("opens its OWN Refund row per refunded unit rather than reusing another one", async () => {
    const { order, items } = await makeDeliveredOrder(2);
    const first = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    const second = await replaceStockItem(prisma, {
      orderItemId: items[1]!.id,
      reason: "dead too",
      executedBy: adminId,
    });

    const a = await refundInsteadOfReplace(prisma, {
      stockReplacementId: first.replacement.id,
      executedBy: adminId,
    });
    const b = await refundInsteadOfReplace(prisma, {
      stockReplacementId: second.replacement.id,
      executedBy: adminId,
    });

    expect(a.refund.id).not.toBe(b.refund.id);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(2);
    expect(await prisma.refundExecution.count()).toBe(2);
  });

  it("audits the fallback with the acting admin id and plain language", async () => {
    const { order, replacement } = await awaitingStockRequest(1);

    const result = await refundInsteadOfReplace(prisma, {
      stockReplacementId: replacement.id,
      executedBy: adminId,
    });

    const rows = await prisma.auditLog.findMany({
      where: { targetType: "stock_replacement", targetId: result.replacement.id },
    });
    expect(rows.some((r) => r.adminId === adminId && r.details!.includes(order.orderCode))).toBe(true);
  });

  it("refuses a request that is not AWAITING_STOCK", async () => {
    const { items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);

    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.refund.count()).toBe(0);
  });

  it("refuses an already-refunded request, so a buyer can never be paid twice for one unit", async () => {
    const { replacement } = await awaitingStockRequest(1);
    await refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId });

    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: replacement.id, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.refundExecution.count()).toBe(1);
  });

  it("refuses an unknown request", async () => {
    await expect(
      refundInsteadOfReplace(prisma, { stockReplacementId: 999_999_999, executedBy: adminId }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a MANUAL_TRANSFER fallback with no proof of the transfer", async () => {
    const { replacement } = await awaitingStockRequest(1);

    await expect(
      refundInsteadOfReplace(prisma, {
        stockReplacementId: replacement.id,
        executedBy: adminId,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
      }),
    ).rejects.toThrow(ValidationError);
    // The whole fallback rolled back — no half-written refund left behind.
    expect(await prisma.refund.count()).toBe(0);
    const reloaded = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(reloaded.status).toBe(StockReplacementStatus.AWAITING_STOCK);
  });
});
