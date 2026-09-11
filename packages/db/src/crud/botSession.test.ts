import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { readBotSession, writeBotSession, deleteBotSession, pruneExpiredBotSessions } from "./botSession";

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.botSession.deleteMany();
});

const FUTURE = () => new Date(Date.now() + 60_000);
const PAST = () => new Date(Date.now() - 60_000);

describe("writeBotSession / readBotSession", () => {
  it("reads back exactly what was written, before expiry", async () => {
    await writeBotSession(prisma, "chat:1", '{"a":1}', "nav", FUTURE());
    expect(await readBotSession(prisma, "chat:1")).toBe('{"a":1}');
  });

  it("returns undefined for a key that was never written", async () => {
    expect(await readBotSession(prisma, "chat:missing")).toBeUndefined();
  });

  it("a second write to the same key overwrites (upsert), not a duplicate row", async () => {
    await writeBotSession(prisma, "chat:2", '{"a":1}', "nav", FUTURE());
    await writeBotSession(prisma, "chat:2", '{"a":2}', "nav", FUTURE());
    expect(await readBotSession(prisma, "chat:2")).toBe('{"a":2}');
    expect(await prisma.botSession.count({ where: { key: "chat:2" } })).toBe(1);
  });

  it("persists the kind ('nav' | 'checkout') alongside the data", async () => {
    await writeBotSession(prisma, "chat:3", "{}", "checkout", FUTURE());
    const row = await prisma.botSession.findUnique({ where: { key: "chat:3" } });
    expect(row?.kind).toBe("checkout");
  });
});

describe("readBotSession — TTL expiry", () => {
  it("a key past its expiresAt reads back as undefined (expired, not just present)", async () => {
    await writeBotSession(prisma, "chat:4", '{"a":1}', "nav", PAST());
    expect(await readBotSession(prisma, "chat:4")).toBeUndefined();
  });

  it("expiry is evaluated against the `now` passed in, not just wall-clock Date.now()", async () => {
    // Written with a future expiresAt relative to wall-clock now, but reading
    // with an explicit `now` PAST that expiresAt still reports expired —
    // proves the comparison uses the given `now`, not a fresh Date.now() call
    // baked into the function.
    const expiresAt = new Date(Date.now() + 5_000);
    await writeBotSession(prisma, "chat:5", '{"a":1}', "nav", expiresAt);
    expect(await readBotSession(prisma, "chat:5")).toBe('{"a":1}'); // not yet expired
    expect(await readBotSession(prisma, "chat:5", new Date(expiresAt.getTime() + 1))).toBeUndefined();
  });

  it("lazily deletes the row on a read past expiry", async () => {
    await writeBotSession(prisma, "chat:6", '{"a":1}', "nav", PAST());
    await readBotSession(prisma, "chat:6");
    expect(await prisma.botSession.findUnique({ where: { key: "chat:6" } })).toBeNull();
  });

  it("a checkout-kind row expires the same way as a nav-kind row (the TTL value itself is the caller's job, not this function's)", async () => {
    await writeBotSession(prisma, "chat:7", "{}", "checkout", PAST());
    expect(await readBotSession(prisma, "chat:7")).toBeUndefined();
  });
});

describe("deleteBotSession", () => {
  it("removes an existing row", async () => {
    await writeBotSession(prisma, "chat:8", "{}", "nav", FUTURE());
    await deleteBotSession(prisma, "chat:8");
    expect(await readBotSession(prisma, "chat:8")).toBeUndefined();
  });

  it("is a no-op (does not throw) for a key that doesn't exist", async () => {
    await expect(deleteBotSession(prisma, "chat:missing")).resolves.toBeUndefined();
  });
});

describe("pruneExpiredBotSessions", () => {
  it("deletes only rows whose expiresAt is before the cutoff", async () => {
    await writeBotSession(prisma, "chat:old", "{}", "nav", PAST());
    await writeBotSession(prisma, "chat:new", "{}", "nav", FUTURE());
    const removed = await pruneExpiredBotSessions(prisma, new Date());
    expect(removed).toBe(1);
    expect(await prisma.botSession.findUnique({ where: { key: "chat:old" } })).toBeNull();
    expect(await prisma.botSession.findUnique({ where: { key: "chat:new" } })).not.toBeNull();
  });

  it("returns 0 when nothing is expired", async () => {
    await writeBotSession(prisma, "chat:new", "{}", "nav", FUTURE());
    const removed = await pruneExpiredBotSessions(prisma, new Date());
    expect(removed).toBe(0);
  });
});
