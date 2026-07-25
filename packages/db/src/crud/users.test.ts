import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { upsertUser, searchUsers, listRecentUsers, totalSpentByUserIds, orderCountByUserIds, setUserRole, setUserBanned, setUserLanguage, adjustWallet } from "./users";
import { primeWarmUser, peekWarmUser } from "./warmUserCache";
import { UserRole } from "@app/core/enums";

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

describe("orderCountByUserIds", () => {
  it("counts orders per user (any status) and omits users with zero orders", async () => {
    const userA = await upsertUser(prisma, { telegramId: 9104, username: "counter_a", fullName: null });
    const userB = await upsertUser(prisma, { telegramId: 9105, username: "counter_b", fullName: null });
    const userC = await upsertUser(prisma, { telegramId: 9106, username: "counter_zero", fullName: null });

    // User A: three orders (various statuses).
    await prisma.order.create({
      data: { orderCode: `ORD-c1-${Math.random()}`, userId: userA.id, subtotalAmount: "10000", totalAmount: "10000", currency: "IDR", status: "DELIVERED" },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-c2-${Math.random()}`, userId: userA.id, subtotalAmount: "5000", totalAmount: "5000", currency: "IDR", status: "PENDING_PAYMENT" },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-c3-${Math.random()}`, userId: userA.id, subtotalAmount: "3", totalAmount: "3.5", currency: "USDT", status: "CANCELLED" },
    });

    // User B: one order.
    await prisma.order.create({
      data: { orderCode: `ORD-d1-${Math.random()}`, userId: userB.id, subtotalAmount: "10", totalAmount: "10", currency: "USDT", status: "DELIVERED" },
    });

    // User C: no orders at all.

    const result = await orderCountByUserIds(prisma, [userA.id, userB.id, userC.id]);

    expect(result.get(userA.id)).toBe(3);
    expect(result.get(userB.id)).toBe(1);
    expect(result.has(userC.id)).toBe(false);
  });

  it("returns an empty Map for an empty input array without querying", async () => {
    const result = await orderCountByUserIds(prisma, []);
    expect(result.size).toBe(0);
  });

  it("includes non-DELIVERED orders in the count", async () => {
    const user = await upsertUser(prisma, { telegramId: 9107, username: "pending_orders", fullName: null });

    // Create orders with different statuses.
    await prisma.order.create({
      data: { orderCode: `ORD-e1-${Math.random()}`, userId: user.id, subtotalAmount: "100", totalAmount: "100", currency: "IDR", status: "PENDING_PAYMENT" },
    });
    await prisma.order.create({
      data: { orderCode: `ORD-e2-${Math.random()}`, userId: user.id, subtotalAmount: "200", totalAmount: "200", currency: "IDR", status: "CANCELLED" },
    });

    const result = await orderCountByUserIds(prisma, [user.id]);

    expect(result.get(user.id)).toBe(2);
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

describe("warm-cache invalidation (bot's registeredUser middleware relies on this)", () => {
  function prime(telegramId: string, userId: number) {
    primeWarmUser(telegramId, {
      id: userId,
      username: "stale",
      fullName: "Stale Name",
      role: "CUSTOMER",
      language: "EN",
      referralCode: "STALE01",
      walletBalance: "0",
      banned: false,
      bannedReason: null,
    });
  }

  it("setUserRole evicts the warm entry", async () => {
    const user = await upsertUser(prisma, { telegramId: 9201, username: "r", fullName: null });
    prime("9201", user.id);
    await setUserRole(prisma, user.id, UserRole.ADMIN);
    expect(peekWarmUser("9201")).toBeUndefined();
  });

  it("setUserBanned evicts the warm entry", async () => {
    const user = await upsertUser(prisma, { telegramId: 9202, username: "b", fullName: null });
    prime("9202", user.id);
    await setUserBanned(prisma, user.id, true, "test");
    expect(peekWarmUser("9202")).toBeUndefined();
  });

  it("setUserLanguage evicts the warm entry (self-service /language must not get reset by a stale hit)", async () => {
    const user = await upsertUser(prisma, { telegramId: 9203, username: "l", fullName: null });
    prime("9203", user.id);
    await setUserLanguage(prisma, user.id, "id");
    expect(peekWarmUser("9203")).toBeUndefined();
  });

  it("adjustWallet evicts the warm entry", async () => {
    const user = await upsertUser(prisma, { telegramId: 9204, username: "w", fullName: null });
    prime("9204", user.id);
    await adjustWallet(prisma, user.id, 10, { allowNegative: true });
    expect(peekWarmUser("9204")).toBeUndefined();
  });
});
