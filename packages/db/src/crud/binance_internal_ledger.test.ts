import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { resetDb } from "../../../../tests/helpers/sampleData";
import { recordUnmatchedTx, listProcessedBinanceTx, countProcessedBinanceTx } from "@app/db";

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

describe("listProcessedBinanceTx / countProcessedBinanceTx — q search", () => {
  it("filters by a substring match on binanceTxId", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "ABC-123", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "XYZ-999", amount: "1.00" });

    const rows = await listProcessedBinanceTx(prisma, { q: "abc" });
    expect(rows.map((r) => r.binanceTxId)).toEqual(["ABC-123"]);

    const count = await countProcessedBinanceTx(prisma, { q: "abc" });
    expect(count).toBe(1);
  });

  it("returns everything when q is empty or omitted", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "ROW-1", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "ROW-2", amount: "1.00" });

    expect((await listProcessedBinanceTx(prisma, {})).length).toBe(2);
    expect((await listProcessedBinanceTx(prisma, { q: "" })).length).toBe(2);
  });

  it("returns an empty array when nothing matches", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "ROW-1", amount: "1.00" });
    const rows = await listProcessedBinanceTx(prisma, { q: "no-such-substring" });
    expect(rows).toEqual([]);
  });

  it("combines q with an outcome filter", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "COMBO-1", amount: "1.00" });
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: "COMBO-2", amount: "1.00", outcome: "dismissed" },
    });

    const rows = await listProcessedBinanceTx(prisma, { q: "combo", outcome: "unmatched" });
    expect(rows.map((r) => r.binanceTxId)).toEqual(["COMBO-1"]);
  });
});
