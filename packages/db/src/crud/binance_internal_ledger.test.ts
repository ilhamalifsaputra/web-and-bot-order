import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { recordUnmatchedTx, countProcessedBinanceTxToday } from "@app/db";

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
  await resetDb(prisma);
  await prisma.processedBinanceTx.deleteMany();
});

describe("countProcessedBinanceTxToday", () => {
  it("counts rows created today and excludes rows from other days", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "TODAY-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "TODAY-2", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "YESTERDAY-1", amount: "1.00" });
    await prisma.processedBinanceTx.update({
      where: { binanceTxId: "YESTERDAY-1" },
      data: { createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    const count = await countProcessedBinanceTxToday(prisma);
    expect(count).toBe(2);
  });

  it("returns 0 when there are no rows today", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "OLD-1", amount: "1.00" });
    await prisma.processedBinanceTx.update({
      where: { binanceTxId: "OLD-1" },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });

    const count = await countProcessedBinanceTxToday(prisma);
    expect(count).toBe(0);
  });

  it("respects an explicit `now` reference for the day boundary", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "FIXED-1", amount: "1.00" });
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const count = await countProcessedBinanceTxToday(prisma, farFuture);
    expect(count).toBe(0); // the row was created "now", not on farFuture's day
  });
});
