import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { getSetting, setSetting, deleteSetting } from "./settings";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("getSetting caching", () => {
  it("returns null for a missing key", async () => {
    expect(await getSetting(prisma, "does_not_exist_key")).toBeNull();
  });

  it("setSetting is immediately visible to getSetting (write-through, not stale for the TTL window)", async () => {
    await setSetting(prisma, "banner_url", "https://example.com/a.png");
    expect(await getSetting(prisma, "banner_url")).toBe("https://example.com/a.png");

    await setSetting(prisma, "banner_url", "https://example.com/b.png");
    expect(await getSetting(prisma, "banner_url")).toBe("https://example.com/b.png");
  });

  it("serves a cached value without hitting the DB again within the TTL, even after the row changes underneath it", async () => {
    await setSetting(prisma, "fx_rate", "15000");
    expect(await getSetting(prisma, "fx_rate")).toBe("15000");

    // Bypass setSetting to simulate a change the cache wouldn't know about.
    await prisma.setting.update({ where: { key: "fx_rate" }, data: { value: "16000" } });
    expect(await getSetting(prisma, "fx_rate")).toBe("15000"); // still cached
  });

  it("re-reads from the DB once the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await setSetting(prisma, "ttl_key", "first");
    expect(await getSetting(prisma, "ttl_key")).toBe("first");

    await prisma.setting.update({ where: { key: "ttl_key" }, data: { value: "second" } });
    vi.setSystemTime(31_000); // past the 30s TTL
    expect(await getSetting(prisma, "ttl_key")).toBe("second");
  });

  it("deleteSetting invalidates the cache immediately", async () => {
    await setSetting(prisma, "to_delete", "value");
    expect(await getSetting(prisma, "to_delete")).toBe("value");

    await deleteSetting(prisma, "to_delete");
    expect(await getSetting(prisma, "to_delete")).toBeNull();
  });
});
