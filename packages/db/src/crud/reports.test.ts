import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { revenueByDay, revenueSummary } from "./reports";

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

describe("revenueByDay", () => {
  it("keeps a delivered USDT order's total out of the IDR bucket for the same day", async () => {
    const now = new Date();
    await prisma.order.create({
      data: {
        orderCode: `ORD-idr-${Math.random()}`, userId,
        subtotalAmount: "54000", totalAmount: "54000", currency: "IDR",
        status: "DELIVERED", deliveredAt: now,
      },
    });
    await prisma.order.create({
      data: {
        orderCode: `ORD-usdt-${Math.random()}`, userId,
        subtotalAmount: "54000", totalAmount: "3.43", currency: "USDT", fxRate: "16000",
        status: "DELIVERED", deliveredAt: now,
      },
    });

    const days = await revenueByDay(prisma, 1);
    expect(days).toHaveLength(1);
    const today = days[0]!;
    expect(today.orders).toBe(2);
    // The IDR bucket must be exactly the IDR order's total — the USDT order's
    // 3.43 must never land in this number (that's the reports-page equivalent
    // of the "Rp3" display bug: a tiny USDT figure silently added to Rupiah).
    expect(today.revenue_idr).toBe("54000");
    expect(today.revenue_usdt).toBe("3.43");
  });

  it("fills empty days with zero in both currencies", async () => {
    const days = await revenueByDay(prisma, 3);
    expect(days).toHaveLength(3);
    for (const d of days) {
      expect(d.revenue_idr).toBe("0");
      expect(d.revenue_usdt).toBe("0");
      expect(d.orders).toBe(0);
    }
  });
});

describe("revenueSummary", () => {
  it("excludes orders delivered after `until`", async () => {
    const now = new Date();
    const before = new Date(now.getTime() - 60_000);
    await prisma.order.create({
      data: { orderCode: `ORD-a-${Math.random()}`, userId, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED", deliveredAt: before },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-b-${Math.random()}`, userId, subtotalAmount: "20000", totalAmount: "20000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });

    const result = await revenueSummary(prisma, new Date(now.getTime() - 120_000), before);
    expect(result.revenue_idr.toString()).toBe("10000");
    expect(result.orders).toBe(1);
  });

  it("defaults `until` to now when omitted", async () => {
    const now = new Date();
    await prisma.order.create({
      data: { orderCode: `ORD-c-${Math.random()}`, userId, subtotalAmount: "5000", totalAmount: "5000", currency: "IDR", status: "DELIVERED", deliveredAt: now },
    });
    const result = await revenueSummary(prisma, new Date(now.getTime() - 60_000));
    expect(result.revenue_idr.toString()).toBe("5000");
  });
});
