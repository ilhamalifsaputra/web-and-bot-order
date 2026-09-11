import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { claimTelegramUpdate, pruneProcessedTelegramUpdates } from "./telegramUpdates";

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
  await prisma.processedTelegramUpdate.deleteMany();
});

describe("claimTelegramUpdate", () => {
  it("returns true the first time an update_id is claimed", async () => {
    const claimed = await claimTelegramUpdate(prisma, 123456789);
    expect(claimed).toBe(true);
    const row = await prisma.processedTelegramUpdate.findUnique({ where: { updateId: 123456789n } });
    expect(row).not.toBeNull();
  });

  it("returns false for a redelivered (already-claimed) update_id, and doesn't create a second row", async () => {
    const first = await claimTelegramUpdate(prisma, 42);
    const second = await claimTelegramUpdate(prisma, 42);
    expect(first).toBe(true);
    expect(second).toBe(false);
    const count = await prisma.processedTelegramUpdate.count({ where: { updateId: 42n } });
    expect(count).toBe(1);
  });

  it("accepts a bigint update_id directly", async () => {
    const claimed = await claimTelegramUpdate(prisma, 9007199254740993n); // > Number.MAX_SAFE_INTEGER
    expect(claimed).toBe(true);
    const row = await prisma.processedTelegramUpdate.findUnique({ where: { updateId: 9007199254740993n } });
    expect(row).not.toBeNull();
  });

  it("two different update_ids are both claimed independently", async () => {
    expect(await claimTelegramUpdate(prisma, 1)).toBe(true);
    expect(await claimTelegramUpdate(prisma, 2)).toBe(true);
    expect(await prisma.processedTelegramUpdate.count()).toBe(2);
  });
});

describe("pruneProcessedTelegramUpdates", () => {
  it("deletes rows older than the cutoff and leaves newer ones", async () => {
    await claimTelegramUpdate(prisma, 100);
    await claimTelegramUpdate(prisma, 200);
    // Backdate row 100 so it falls before the cutoff.
    await prisma.processedTelegramUpdate.update({
      where: { updateId: 100n },
      data: { processedAt: new Date(Date.now() - 10 * 24 * 3_600_000) },
    });

    const cutoff = new Date(Date.now() - 3 * 24 * 3_600_000);
    const removed = await pruneProcessedTelegramUpdates(prisma, cutoff);

    expect(removed).toBe(1);
    expect(await prisma.processedTelegramUpdate.findUnique({ where: { updateId: 100n } })).toBeNull();
    expect(await prisma.processedTelegramUpdate.findUnique({ where: { updateId: 200n } })).not.toBeNull();
  });

  it("returns 0 when nothing is old enough to prune", async () => {
    await claimTelegramUpdate(prisma, 300);
    const removed = await pruneProcessedTelegramUpdates(prisma, new Date(Date.now() - 3 * 24 * 3_600_000));
    expect(removed).toBe(0);
  });
});
