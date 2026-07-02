import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { upsertUser, searchUsers, listRecentUsers, totalSpentByUserIds } from "./users";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});

describe("listRecentUsers", () => {
  it("orders by createdAt descending and respects the limit", async () => {
    const oldest = await upsertUser(prisma, { telegramId: 9001, username: "oldest", fullName: null });
    // Force a distinct, ordered createdAt so the test isn't relying on
    // same-millisecond insert order.
    await prisma.user.update({ where: { id: oldest.id }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const newest = await upsertUser(prisma, { telegramId: 9002, username: "newest", fullName: null });

    const recent = await listRecentUsers(prisma, 1);
    expect(recent.length).toBe(1);
    expect(recent[0]!.id).toBe(newest.id);

    const both = await listRecentUsers(prisma, 50);
    const ids = both.map((u) => u.id);
    expect(ids.indexOf(newest.id)).toBeLessThan(ids.indexOf(oldest.id));
  });
});

describe("searchUsers (existing behavior, unchanged)", () => {
  it("finds a user by username substring", async () => {
    await upsertUser(prisma, { telegramId: 9003, username: "findme_search", fullName: null });
    const results = await searchUsers(prisma, "findme_search");
    expect(results.some((u) => u.username === "findme_search")).toBe(true);
  });

  it("returns empty for a blank query", async () => {
    expect(await searchUsers(prisma, "   ")).toEqual([]);
  });
});

describe("totalSpentByUserIds", () => {
  it("sums DELIVERED orders per user, split by currency, and omits users with no orders", async () => {
    const userA = await upsertUser(prisma, { telegramId: 9101, username: "spender_a", fullName: null });
    const userB = await upsertUser(prisma, { telegramId: 9102, username: "spender_b", fullName: null });
    const userC = await upsertUser(prisma, { telegramId: 9103, username: "spender_zero", fullName: null });

    // User A: two DELIVERED IDR orders + one DELIVERED USDT order.
    await prisma.order.create({
      data: { orderCode: `ORD-a1-${Math.random()}`, userId: userA.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED" },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-a2-${Math.random()}`, userId: userA.id, subtotalAmount: "5000", totalAmount: "5000", currency: "IDR", status: "DELIVERED" },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-a3-${Math.random()}`, userId: userA.id, subtotalAmount: "3", totalAmount: "3.5", currency: "USDT", fxRate: "16000", status: "DELIVERED" },
    });
    // User A: a non-DELIVERED order that must NOT be counted.
    await prisma.order.create({
      data: { orderCode: `ORD-a4-${Math.random()}`, userId: userA.id, subtotalAmount: "999999", totalAmount: "999999", currency: "IDR", status: "PENDING_PAYMENT" },
    });

    // User B: one DELIVERED USDT order only.
    await prisma.order.create({
      data: { orderCode: `ORD-b1-${Math.random()}`, userId: userB.id, subtotalAmount: "10", totalAmount: "10", currency: "USDT", status: "DELIVERED" },
    });

    // User C: no orders at all.

    const result = await totalSpentByUserIds(prisma, [userA.id, userB.id, userC.id]);

    const aTotals = result.get(userA.id);
    expect(aTotals).toBeDefined();
    expect(aTotals!.idr.equals(new Decimal("15000"))).toBe(true);
    expect(aTotals!.usdt.equals(new Decimal("3.5"))).toBe(true);

    const bTotals = result.get(userB.id);
    expect(bTotals).toBeDefined();
    expect(bTotals!.idr.equals(new Decimal(0))).toBe(true);
    expect(bTotals!.usdt.equals(new Decimal("10"))).toBe(true);

    expect(result.has(userC.id)).toBe(false);
  });

  it("returns an empty Map for an empty input array without querying", async () => {
    const result = await totalSpentByUserIds(prisma, []);
    expect(result.size).toBe(0);
  });
});

describe("searchUsers (website customers, no telegram link)", () => {
  it("finds a website-only user by login username or email", async () => {
    const webUser = await prisma.user.create({
      data: {
        loginUsername: "webby",
        email: "webby@test.com",
        referralCode: "WEBBYREF",
      },
    });

    const byUsername = await searchUsers(prisma, "webby");
    expect(byUsername.some((u) => u.id === webUser.id)).toBe(true);

    const byEmail = await searchUsers(prisma, "webby@test.com");
    expect(byEmail.some((u) => u.id === webUser.id)).toBe(true);
  });
});
