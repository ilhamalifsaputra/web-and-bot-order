/**
 * Fase 7: StockItem.replacesStockItemId is a real self-referencing FK
 * (onDelete SetNull), so a warranty-replacement chain can never dangle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

const newRow = (data: { replacesStockItemId?: number | null } = {}) =>
  prisma.stockItem.create({ data: { productId: sample.product.id, credentials: "x", ...data } });

describe("StockItem.replacesStockItemId self-relation", () => {
  it("rejects a pointer to a StockItem that does not exist", async () => {
    await expect(newRow({ replacesStockItemId: 999_999_999 })).rejects.toMatchObject({ code: "P2003" });
  });

  it("links a spare to the row it replaced, in both directions", async () => {
    const original = await newRow();
    const spare = await newRow({ replacesStockItemId: original.id });
    const loaded = await prisma.stockItem.findUniqueOrThrow({
      where: { id: original.id },
      include: { replacedBy: true, replacesStockItem: true },
    });
    expect(loaded.replacedBy.map((r) => r.id)).toEqual([spare.id]);
    expect(loaded.replacesStockItem).toBeNull();
  });

  it("sets the pointer to NULL when the replaced row is deleted (SetNull)", async () => {
    const original = await newRow();
    const spare = await newRow({ replacesStockItemId: original.id });
    await prisma.stockItem.delete({ where: { id: original.id } });
    expect((await prisma.stockItem.findUniqueOrThrow({ where: { id: spare.id } })).replacesStockItemId).toBeNull();
  });

  it("lets a whole chain be wiped with one deleteMany (what resetDb does)", async () => {
    const a = await newRow();
    const b = await newRow({ replacesStockItemId: a.id });
    await newRow({ replacesStockItemId: b.id });
    await prisma.stockItemEvent.deleteMany(); // events are FK Restrict
    await prisma.stockItem.deleteMany();
    expect(await prisma.stockItem.count()).toBe(0);
  });
});
