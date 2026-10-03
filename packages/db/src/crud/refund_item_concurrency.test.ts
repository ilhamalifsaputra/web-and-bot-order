/**
 * True-concurrency regression tests for `createRefundItem` (./refunds.ts).
 *
 * It enforces two aggregate budgets — the per-OrderItem subtotal (summed
 * across every live Refund) and the per-Refund quoted amount — by summing the
 * existing RefundItem rows and then inserting. Under Postgres READ COMMITTED
 * two concurrent calls both read the same pre-insert sum, both pass, and both
 * insert, overrunning the budget. These fire the competing calls at the same
 * instant via `Promise.allSettled` against the real dev Postgres, through the
 * bare `prisma` client (a caller that is not already in a transaction).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { ValidationError } from "@app/core/errors";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import { createRefund, createRefundItem } from "./refunds";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let adminId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  // Warm the pool so the burst contends on the order row, not on cold
  // connection setup (see wallet_concurrency.test.ts).
  await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({
    data: { telegramId: Math.floor(Math.random() * 1_000_000_000), username: "admin", fullName: "Admin", role: "ADMIN", referralCode: `a${Math.random()}` },
  });
  adminId = admin.id;
});

async function makeOrderWithItem() {
  const order = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  const subtotal = new Decimal(item.unitPrice.toString()).times(item.quantity);
  return { order, item, subtotal };
}

describe("createRefundItem under true Postgres concurrency", () => {
  it("two items on two refunds that together exceed the order item's subtotal: only one is inserted", async () => {
    const { order, item, subtotal } = await makeOrderWithItem();
    // Each alone fits (60% of the subtotal); together they are 120%.
    const part = subtotal.times("0.6").toDecimalPlaces(2);
    const refundA = await createRefund(prisma, { orderId: order.id, amount: part, currency: order.currency, adminId });
    const refundB = await createRefund(prisma, { orderId: order.id, amount: part, currency: order.currency, adminId });

    const results = await Promise.allSettled([
      createRefundItem(prisma, { refundId: refundA.id, orderItemId: item.id, amount: part, adminId }),
      createRefundItem(prisma, { refundId: refundB.id, orderItemId: item.id, amount: part, adminId }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ValidationError);
    expect(rejected[0]!.reason).toMatchObject({ key: "error.refund_exceeds_item_subtotal" });
    expect(await prisma.refundItem.count({ where: { orderItemId: item.id } })).toBe(1);
  });

  it("two items on the same refund that together exceed its quoted amount: only one is inserted", async () => {
    const { order, item, subtotal } = await makeOrderWithItem();
    const quoted = subtotal.times("0.5").toDecimalPlaces(2);
    const each = quoted.times("0.6").toDecimalPlaces(2);
    const refund = await createRefund(prisma, { orderId: order.id, amount: quoted, currency: order.currency, adminId });

    const results = await Promise.allSettled([
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: each, adminId }),
      createRefundItem(prisma, { refundId: refund.id, orderItemId: item.id, amount: each, adminId }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toMatchObject({ key: "error.refund_item_exceeds_refund_amount" });
    expect(await prisma.refundItem.count({ where: { refundId: refund.id } })).toBe(1);
  });

  it("concurrent items that together still fit: all are inserted", async () => {
    const { order, item, subtotal } = await makeOrderWithItem();
    const part = subtotal.times("0.25").toDecimalPlaces(2);
    const refunds = await Promise.all(
      [0, 1, 2].map(() => createRefund(prisma, { orderId: order.id, amount: part, currency: order.currency, adminId })),
    );
    const results = await Promise.allSettled(
      refunds.map((r) => createRefundItem(prisma, { refundId: r.id, orderItemId: item.id, amount: part, adminId })),
    );
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(3);
  });
});
