import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  countPendingPaymentLike,
  countProcessing,
  countPendingVerifications,
  countUnderpaid,
  countExpiredPending,
} from "./orders";

let db: TestDb;
let prisma: PrismaClient;
let userId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  const user = await prisma.user.create({
    data: { telegramId: BigInt(Math.floor(Math.random() * 1e15)), referralCode: `r${Math.random()}` },
  });
  userId = user.id;
});

function makeOrder(status: string, extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: { orderCode: `ORD-${Math.random()}`, userId, subtotalAmount: "1", totalAmount: "1", status, ...extra },
  });
}

describe("order status counts", () => {
  it("countPendingPaymentLike counts PENDING_PAYMENT, PAYMENT_DETECTED, and CONFIRMING", async () => {
    await makeOrder("PENDING_PAYMENT");
    await makeOrder("PAYMENT_DETECTED");
    await makeOrder("CONFIRMING");
    await makeOrder("DELIVERED");
    expect(await countPendingPaymentLike(prisma)).toBe(3);
  });

  it("countProcessing counts CONFIRMED and PAID", async () => {
    await makeOrder("CONFIRMED");
    await makeOrder("PAID");
    await makeOrder("DELIVERED");
    expect(await countProcessing(prisma)).toBe(2);
  });

  it("countPendingVerifications counts every PENDING_VERIFICATION row, with no page-size cap", async () => {
    for (let i = 0; i < 5; i++) await makeOrder("PENDING_VERIFICATION");
    expect(await countPendingVerifications(prisma)).toBe(5);
  });

  it("countUnderpaid counts UNDERPAID orders", async () => {
    await makeOrder("UNDERPAID");
    await makeOrder("PAID");
    expect(await countUnderpaid(prisma)).toBe(1);
  });

  it("countExpiredPending counts only PENDING_PAYMENT orders whose expiresAt has passed", async () => {
    const now = new Date();
    await makeOrder("PENDING_PAYMENT", { expiresAt: new Date(now.getTime() - 60_000) });
    await makeOrder("PENDING_PAYMENT", { expiresAt: new Date(now.getTime() + 60_000) });
    await makeOrder("PENDING_PAYMENT", { expiresAt: null });
    expect(await countExpiredPending(prisma, now)).toBe(1);
  });
});
