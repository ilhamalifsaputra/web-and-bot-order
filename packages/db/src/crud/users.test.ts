import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { upsertUser, searchUsers, listRecentUsers } from "./users";

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
