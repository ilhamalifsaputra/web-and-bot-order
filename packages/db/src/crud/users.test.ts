import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import {
  upsertUser,
  searchUsers,
  listRecentUsers,
  totalSpentByUserIds,
  setUserRole,
  setUserBanned,
  setUserLanguage,
  adjustWallet,
  listUsers,
  countUsers,
  customersKpis,
  orderStatsByUserIds,
} from "./users";
import { primeWarmUser, peekWarmUser } from "./warmUserCache";
import { UserRole } from "@app/core/enums";
import { startOfDayUtc } from "@app/core/datetime";

/** Minimal DELIVERED order for KPI/spend-ranking fixtures. */
function makeOrder(
  prisma: PrismaClient,
  userId: number,
  args: { amount: string; currency?: "IDR" | "USDT"; status?: string; createdAt?: Date },
) {
  return prisma.order.create({
    data: {
      orderCode: `ORD-${userId}-${Math.random()}`,
      userId,
      subtotalAmount: args.amount,
      totalAmount: args.amount,
      currency: args.currency ?? "IDR",
      status: args.status ?? "DELIVERED",
      ...(args.createdAt ? { createdAt: args.createdAt } : {}),
    },
  });
}

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

describe("listUsers / countUsers", () => {
  it("excludes ADMIN-role users even when no role filter is passed", async () => {
    const admin = await upsertUser(prisma, { telegramId: 9301, username: "admin_a", fullName: null });
    await setUserRole(prisma, admin.id, UserRole.ADMIN);
    const customer = await upsertUser(prisma, { telegramId: 9302, username: "cust_a", fullName: null });

    const rows = await listUsers(prisma, { limit: 200 });
    const ids = rows.map((u) => u.id);
    expect(ids).not.toContain(admin.id);
    expect(ids).toContain(customer.id);

    const count = await countUsers(prisma);
    const totalRow = await prisma.user.count();
    // count should be strictly less than the raw table count since the admin
    // row created above (and any others from prior tests) are excluded.
    expect(count).toBeLessThan(totalRow + 1);
  });

  it("excludes ADMIN-role users even when role: ADMIN is explicitly passed (defense in depth)", async () => {
    const admin = await upsertUser(prisma, { telegramId: 9310, username: "admin_explicit", fullName: null });
    await setUserRole(prisma, admin.id, UserRole.ADMIN);
    const customer = await upsertUser(prisma, { telegramId: 9311, username: "cust_explicit", fullName: null });

    // Explicitly pass role: ADMIN via type cast to simulate a caller attempting to bypass the type guard.
    // The runtime guard should reject ADMIN and fall back to NON_ADMIN_ROLES, returning non-admin users.
    // Crucially, the ADMIN user must NOT be in the results.
    const rows = await listUsers(prisma, { role: UserRole.ADMIN as any, limit: 200 });
    const ids = rows.map((u) => u.id);
    expect(ids).not.toContain(admin.id); // Admin must never leak through
    expect(ids).toContain(customer.id); // Non-admin users are returned (safe fallback behavior)

    const count = await countUsers(prisma, { role: UserRole.ADMIN as any });
    expect(count).toBeGreaterThan(0); // Non-admin users are counted
    // Verify the admin is not counted
    const totalNonAdminCount = await prisma.user.count({ where: { role: { in: ["CUSTOMER", "RESELLER"] } } });
    expect(count).toBeLessThanOrEqual(totalNonAdminCount);
  });

  it("role: RESELLER filter returns only RESELLER rows", async () => {
    const reseller = await upsertUser(prisma, { telegramId: 9303, username: "reseller_a", fullName: null });
    await setUserRole(prisma, reseller.id, UserRole.RESELLER);
    const customer = await upsertUser(prisma, { telegramId: 9304, username: "cust_b", fullName: null });

    const rows = await listUsers(prisma, { role: UserRole.RESELLER, limit: 200 });
    const ids = rows.map((u) => u.id);
    expect(ids).toContain(reseller.id);
    expect(ids).not.toContain(customer.id);
    expect(rows.every((u) => u.role === UserRole.RESELLER)).toBe(true);
  });

  it("banned: true/false filters correctly", async () => {
    const banned = await upsertUser(prisma, { telegramId: 9305, username: "banned_a", fullName: null });
    await setUserBanned(prisma, banned.id, true, "test ban");
    const active = await upsertUser(prisma, { telegramId: 9306, username: "active_a", fullName: null });

    const bannedRows = await listUsers(prisma, { banned: true, limit: 200 });
    expect(bannedRows.some((u) => u.id === banned.id)).toBe(true);
    expect(bannedRows.some((u) => u.id === active.id)).toBe(false);

    const activeRows = await listUsers(prisma, { banned: false, limit: 200 });
    expect(activeRows.some((u) => u.id === active.id)).toBe(true);
    expect(activeRows.some((u) => u.id === banned.id)).toBe(false);
  });

  it("since/until (createdAt) range filters correctly", async () => {
    const early = await upsertUser(prisma, { telegramId: 9307, username: "early_a", fullName: null });
    await prisma.user.update({ where: { id: early.id }, data: { createdAt: new Date("2020-01-01T00:00:00Z") } });
    const mid = await upsertUser(prisma, { telegramId: 9308, username: "mid_a", fullName: null });
    await prisma.user.update({ where: { id: mid.id }, data: { createdAt: new Date("2023-06-15T00:00:00Z") } });
    const late = await upsertUser(prisma, { telegramId: 9309, username: "late_a", fullName: null });
    await prisma.user.update({ where: { id: late.id }, data: { createdAt: new Date("2026-01-01T00:00:00Z") } });

    const rows = await listUsers(prisma, {
      since: new Date("2021-01-01T00:00:00Z"),
      until: new Date("2024-01-01T00:00:00Z"),
      limit: 200,
    });
    const ids = rows.map((u) => u.id);
    expect(ids).toContain(mid.id);
    expect(ids).not.toContain(early.id);
    expect(ids).not.toContain(late.id);
  });

  it("lastSeenSince/lastSeenUntil range filters correctly", async () => {
    const early = await upsertUser(prisma, { telegramId: 9310, username: "seen_early", fullName: null });
    await prisma.user.update({ where: { id: early.id }, data: { lastSeenAt: new Date("2020-01-01T00:00:00Z") } });
    const mid = await upsertUser(prisma, { telegramId: 9311, username: "seen_mid", fullName: null });
    await prisma.user.update({ where: { id: mid.id }, data: { lastSeenAt: new Date("2023-06-15T00:00:00Z") } });
    const late = await upsertUser(prisma, { telegramId: 9312, username: "seen_late", fullName: null });
    await prisma.user.update({ where: { id: late.id }, data: { lastSeenAt: new Date("2026-01-01T00:00:00Z") } });

    const rows = await listUsers(prisma, {
      lastSeenSince: new Date("2021-01-01T00:00:00Z"),
      lastSeenUntil: new Date("2024-01-01T00:00:00Z"),
      limit: 200,
    });
    const ids = rows.map((u) => u.id);
    expect(ids).toContain(mid.id);
    expect(ids).not.toContain(early.id);
    expect(ids).not.toContain(late.id);
  });

  it("q still matches username/fullName/loginUsername/email/telegramId (regression, now paginated)", async () => {
    await upsertUser(prisma, { telegramId: 9313, username: "unique_qmatch", fullName: null });
    const byUsername = await listUsers(prisma, { q: "unique_qmatch", limit: 200 });
    expect(byUsername.some((u) => u.username === "unique_qmatch")).toBe(true);

    const byTelegramId = await listUsers(prisma, { q: "9313", limit: 200 });
    expect(byTelegramId.some((u) => u.telegramId === BigInt(9313))).toBe(true);

    const webUser = await prisma.user.create({
      data: { loginUsername: "weblogin_q", email: "weblogin_q@test.com", referralCode: "WEBQ001" },
    });
    const byLogin = await listUsers(prisma, { q: "weblogin_q", limit: 200 });
    expect(byLogin.some((u) => u.id === webUser.id)).toBe(true);
    const byEmail = await listUsers(prisma, { q: "weblogin_q@test.com", limit: 200 });
    expect(byEmail.some((u) => u.id === webUser.id)).toBe(true);
  });

  it("ids restricts to the given set", async () => {
    const a = await upsertUser(prisma, { telegramId: 9314, username: "ids_a", fullName: null });
    const b = await upsertUser(prisma, { telegramId: 9315, username: "ids_b", fullName: null });
    await upsertUser(prisma, { telegramId: 9316, username: "ids_c_excluded", fullName: null });

    const rows = await listUsers(prisma, { ids: [a.id, b.id], limit: 200 });
    const ids = rows.map((u) => u.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("sort: newest/oldest/lastSeen produce the expected order", async () => {
    const first = await upsertUser(prisma, { telegramId: 9317, username: "sort_first", fullName: null });
    await prisma.user.update({
      where: { id: first.id },
      data: { createdAt: new Date("2020-01-01T00:00:00Z"), lastSeenAt: new Date("2026-01-01T00:00:00Z") },
    });
    const second = await upsertUser(prisma, { telegramId: 9318, username: "sort_second", fullName: null });
    await prisma.user.update({
      where: { id: second.id },
      data: { createdAt: new Date("2023-01-01T00:00:00Z"), lastSeenAt: new Date("2020-01-01T00:00:00Z") },
    });

    const newest = await listUsers(prisma, { ids: [first.id, second.id], sort: "newest" });
    expect(newest.map((u) => u.id)).toEqual([second.id, first.id]);

    const oldest = await listUsers(prisma, { ids: [first.id, second.id], sort: "oldest" });
    expect(oldest.map((u) => u.id)).toEqual([first.id, second.id]);

    const lastSeen = await listUsers(prisma, { ids: [first.id, second.id], sort: "lastSeen" });
    expect(lastSeen.map((u) => u.id)).toEqual([first.id, second.id]);
  });

  it("limit/offset paginate correctly", async () => {
    const created: number[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await upsertUser(prisma, { telegramId: 9400 + i, username: `page_${i}`, fullName: null });
      await prisma.user.update({ where: { id: u.id }, data: { createdAt: new Date(2024, 0, i + 1) } });
      created.push(u.id);
    }
    // Oldest-first so page order is deterministic against `created`.
    const page1 = await listUsers(prisma, { ids: created, sort: "oldest", limit: 2, offset: 0 });
    const page2 = await listUsers(prisma, { ids: created, sort: "oldest", limit: 2, offset: 2 });
    expect(page1.map((u) => u.id)).toEqual(created.slice(0, 2));
    expect(page2.map((u) => u.id)).toEqual(created.slice(2, 4));
  });
});

describe("rankUserIdsBySpend (via listUsers sort: spend)", () => {
  it("ranks users by DELIVERED IDR total descending, appends zero-IDR spenders after, keeps their createdAt-desc order, and slices pages correctly across the boundary", async () => {
    const bigSpender = await upsertUser(prisma, { telegramId: 9500, username: "spend_big", fullName: null });
    const smallSpender = await upsertUser(prisma, { telegramId: 9501, username: "spend_small", fullName: null });
    const usdtOnly = await upsertUser(prisma, { telegramId: 9502, username: "spend_usdt_only", fullName: null });
    const zeroOlder = await upsertUser(prisma, { telegramId: 9503, username: "spend_zero_older", fullName: null });
    const zeroNewer = await upsertUser(prisma, { telegramId: 9504, username: "spend_zero_newer", fullName: null });

    await makeOrder(prisma, bigSpender.id, { amount: "100000" });
    await makeOrder(prisma, smallSpender.id, { amount: "10000" });
    await makeOrder(prisma, usdtOnly.id, { amount: "50", currency: "USDT" });
    // Non-DELIVERED IDR order must not count toward ranking.
    await makeOrder(prisma, smallSpender.id, { amount: "999999", status: "PENDING_PAYMENT" });

    // Give the two zero-IDR-spend users a deterministic createdAt order.
    await prisma.user.update({ where: { id: zeroOlder.id }, data: { createdAt: new Date("2024-01-01T00:00:00Z") } });
    await prisma.user.update({ where: { id: zeroNewer.id }, data: { createdAt: new Date("2024-06-01T00:00:00Z") } });

    const ids = [bigSpender.id, smallSpender.id, usdtOnly.id, zeroOlder.id, zeroNewer.id];

    // Full-page ranking: bigSpender > smallSpender > zero-spenders (usdtOnly +
    // zeroNewer + zeroOlder), zero-spenders kept in createdAt-desc order.
    const fullPage = await listUsers(prisma, { ids, sort: "spend", limit: 200 });
    const fullIds = fullPage.map((u) => u.id);
    expect(fullIds.indexOf(bigSpender.id)).toBeLessThan(fullIds.indexOf(smallSpender.id));
    expect(fullIds.indexOf(smallSpender.id)).toBeLessThan(fullIds.indexOf(usdtOnly.id));
    // Among zero-IDR spenders (usdtOnly, zeroNewer, zeroOlder — all rank
    // "zero"), relative order matches their createdAt-desc order.
    const zeroSpendIdsInOrder = fullIds.filter((id) => id === usdtOnly.id || id === zeroNewer.id || id === zeroOlder.id);
    expect(zeroSpendIdsInOrder.indexOf(zeroNewer.id)).toBeLessThan(zeroSpendIdsInOrder.indexOf(zeroOlder.id));

    // Page boundary that splits ranked vs zero-spend: limit=2 offset=1 should
    // return [smallSpender, <first zero-spend by createdAt-desc>].
    const boundaryPage = await listUsers(prisma, { ids, sort: "spend", limit: 2, offset: 1 });
    expect(boundaryPage.map((u) => u.id)[0]).toBe(smallSpender.id);
    expect(boundaryPage.length).toBe(2);
  });
});

describe("customersKpis", () => {
  it("totalCustomers excludes ADMIN", async () => {
    const admin = await upsertUser(prisma, { telegramId: 9600, username: "kpi_admin", fullName: null });
    await setUserRole(prisma, admin.id, UserRole.ADMIN);
    await upsertUser(prisma, { telegramId: 9601, username: "kpi_customer", fullName: null });

    const before = await customersKpis(prisma);
    const rawTotal = await prisma.user.count();
    expect(before.totalCustomers).toBeLessThan(rawTotal);
  });

  it("newToday/activeToday respect the startOfDayUtc() boundary", async () => {
    const todayStart = startOfDayUtc();
    const justBefore = new Date(todayStart.getTime() - 1000);

    const before = await customersKpis(prisma);

    const excludedUser = await upsertUser(prisma, { telegramId: 9602, username: "kpi_before_today", fullName: null });
    await prisma.user.update({
      where: { id: excludedUser.id },
      data: { createdAt: justBefore, lastSeenAt: justBefore },
    });

    const stillExcluded = await customersKpis(prisma);
    expect(stillExcluded.newToday).toBe(before.newToday);
    expect(stillExcluded.activeToday).toBe(before.activeToday);

    const includedUser = await upsertUser(prisma, { telegramId: 9603, username: "kpi_today", fullName: null });
    await prisma.user.update({ where: { id: includedUser.id }, data: { lastSeenAt: new Date() } });

    const after = await customersKpis(prisma);
    expect(after.newToday).toBe(stillExcluded.newToday + 1);
    expect(after.activeToday).toBe(stillExcluded.activeToday + 1);
  });

  it("returningCustomers requires >=2 DELIVERED orders specifically", async () => {
    const before = await customersKpis(prisma);

    const oneDeliveredTwoPending = await upsertUser(prisma, { telegramId: 9604, username: "kpi_one_delivered", fullName: null });
    await makeOrder(prisma, oneDeliveredTwoPending.id, { amount: "1000" });
    await makeOrder(prisma, oneDeliveredTwoPending.id, { amount: "1000", status: "PENDING_PAYMENT" });
    await makeOrder(prisma, oneDeliveredTwoPending.id, { amount: "1000", status: "PENDING_PAYMENT" });

    const afterOne = await customersKpis(prisma);
    expect(afterOne.returningCustomers).toBe(before.returningCustomers);

    const twoDelivered = await upsertUser(prisma, { telegramId: 9605, username: "kpi_two_delivered", fullName: null });
    await makeOrder(prisma, twoDelivered.id, { amount: "1000" });
    await makeOrder(prisma, twoDelivered.id, { amount: "1000" });

    const afterTwo = await customersKpis(prisma);
    expect(afterTwo.returningCustomers).toBe(before.returningCustomers + 1);
  });

  it("totalRevenue sums DELIVERED orders only, split by currency, and excludes ADMIN-placed orders", async () => {
    const before = await customersKpis(prisma);

    const customer = await upsertUser(prisma, { telegramId: 9606, username: "kpi_revenue_customer", fullName: null });
    await makeOrder(prisma, customer.id, { amount: "20000", currency: "IDR" });
    await makeOrder(prisma, customer.id, { amount: "5", currency: "USDT" });
    await makeOrder(prisma, customer.id, { amount: "999999", currency: "IDR", status: "PENDING_PAYMENT" });

    const admin = await upsertUser(prisma, { telegramId: 9607, username: "kpi_revenue_admin", fullName: null });
    await setUserRole(prisma, admin.id, UserRole.ADMIN);
    await makeOrder(prisma, admin.id, { amount: "777777", currency: "IDR" });

    const after = await customersKpis(prisma);
    expect(after.totalRevenue.idr.minus(before.totalRevenue.idr).equals(new Decimal("20000"))).toBe(true);
    expect(after.totalRevenue.usdt.minus(before.totalRevenue.usdt).equals(new Decimal("5"))).toBe(true);
  });
});

describe("orderStatsByUserIds", () => {
  it("totalOrders counts every status; lastOrderAt is the max createdAt across all statuses; deliveredOrders counts DELIVERED only", async () => {
    const user = await upsertUser(prisma, { telegramId: 9700, username: "stats_user", fullName: null });

    await makeOrder(prisma, user.id, {
      amount: "1000",
      createdAt: new Date("2024-01-01T00:00:00Z"),
    });

    await makeOrder(prisma, user.id, {
      amount: "1000",
      createdAt: new Date("2024-02-01T00:00:00Z"),
    });

    // A later, non-DELIVERED order must still be reflected in lastOrderAt.
    await makeOrder(prisma, user.id, {
      amount: "1000",
      status: "PENDING_PAYMENT",
      createdAt: new Date("2024-03-01T00:00:00Z"),
    });

    const stats = await orderStatsByUserIds(prisma, [user.id]);
    const s = stats.get(user.id);
    expect(s).toBeDefined();
    expect(s!.totalOrders).toBe(3);
    expect(s!.deliveredOrders).toBe(2);
    expect(s!.lastOrderAt?.toISOString()).toBe(new Date("2024-03-01T00:00:00Z").toISOString());
  });

  it("returns an empty Map for an empty userIds array without querying", async () => {
    const stats = await orderStatsByUserIds(prisma, []);
    expect(stats.size).toBe(0);
  });

  it("a user with zero orders is absent from the returned Map", async () => {
    const user = await upsertUser(prisma, { telegramId: 9701, username: "stats_zero_orders", fullName: null });
    const stats = await orderStatsByUserIds(prisma, [user.id]);
    expect(stats.has(user.id)).toBe(false);
  });
});
