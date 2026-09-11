/**
 * True-concurrency regression tests for the atomic stock-reservation guard
 * — Postgres migration verification (Task 4).
 *
 * `allocateOneAvailableStock` (./stock.ts) grabs one AVAILABLE row via a
 * conditional `updateMany` (`WHERE id = candidate AND status = AVAILABLE`),
 * retrying up to 5 times if it loses a race. Every existing test that
 * exercises this — including order_creation.test.ts's "out-of-stock request
 * throws and leaks no RESERVED rows" — calls it sequentially, one `await` at
 * a time. SQLite's single-writer serialization made that indistinguishable
 * from "the guard holds under concurrency" — there was never more than one
 * writer to race in the first place. These tests fire multiple
 * `createOrderDirect` calls at the SAME instant via `Promise.allSettled`
 * against the real dev Postgres, which has actual concurrent writers, and
 * assert on the state after they all settle.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, markStockDead, countAvailableStock, upsertUser } from "@app/db";

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

/** `n` distinct buyers, one per concurrent request — a shared buyer would
 *  confound "5 concurrent requests" with "cart/wallet state reused". */
async function makeBuyers(n: number) {
  const buyers = [];
  for (let i = 0; i < n; i++) {
    buyers.push(
      await upsertUser(prisma, { telegramId: 900000 + i, username: `concurrency-buyer-${i}`, fullName: `Buyer ${i}` }),
    );
  }
  return buyers;
}

/** Kill all but `keep` of the product's seeded stock (oldest-first), leaving
 *  exactly `keep` AVAILABLE rows — same pattern as order_creation.test.ts's
 *  "out-of-stock request throws and leaks no RESERVED rows" test. */
async function reduceStockTo(productId: number, keep: number) {
  const items = await prisma.stockItem.findMany({ where: { productId }, orderBy: { id: "asc" } });
  for (const item of items.slice(keep)) {
    await markStockDead(prisma, item.id, "test: reduced for concurrency scenario");
  }
}

/** No StockItem row was reserved by more than one order — the real detector
 *  for double-reservation, since `orderItem.stockItemId` (not
 *  `stockItem.orderId`, which only ever holds one value) is where a second
 *  writer overwriting the first's claim would leave a trace: two OrderItems
 *  pointing at the same stock row. */
async function assertNoDoubleReservation() {
  const dupes = await prisma.orderItem.groupBy({
    by: ["stockItemId"],
    where: { stockItemId: { not: null } },
    _count: { stockItemId: true },
    having: { stockItemId: { _count: { gt: 1 } } },
  });
  expect(dupes).toEqual([]);
}

describe("createOrderDirect under true Postgres concurrency", () => {
  it("Case A — 1 available stock item, 5 concurrent buyers (qty=1 each): exactly 1 succeeds, 4 fail cleanly, no double-reservation", async () => {
    const { product } = sample;
    await reduceStockTo(product.id, 1);
    expect(await countAvailableStock(prisma, product.id)).toBe(1);
    const deadBefore = await prisma.stockItem.findMany({ where: { productId: product.id, status: "DEAD" } });
    expect(deadBefore.length).toBe(4);

    const buyers = await makeBuyers(5);
    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 1 })),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrderDirect>>> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    // Don't assume which buyer wins — just count outcomes from the settled results.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect(r.reason).toMatchObject({ key: "error.out_of_stock" });
    }

    const winningOrder = fulfilled[0]!.value!;
    const reserved = await prisma.stockItem.findMany({ where: { productId: product.id, status: "RESERVED" } });
    expect(reserved.length).toBe(1);
    expect(reserved[0]!.orderId).toBe(winningOrder.id);

    // The 4 already-dead items are untouched by the race.
    const deadAfter = await prisma.stockItem.findMany({ where: { productId: product.id, status: "DEAD" } });
    expect(deadAfter.map((s) => s.id).sort()).toEqual(deadBefore.map((s) => s.id).sort());

    await assertNoDoubleReservation();
  });

  it("Case B — 1 available stock item, exactly 1 buyer (sanity control): succeeds cleanly", async () => {
    const { product, user } = sample;
    await reduceStockTo(product.id, 1);

    const order = await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 });
    expect(order).not.toBeNull();

    const reserved = await prisma.stockItem.findMany({ where: { productId: product.id, status: "RESERVED" } });
    expect(reserved.length).toBe(1);
    expect(reserved[0]!.orderId).toBe(order!.id);
  });

  it("Case C — 5 available stock items, 5 concurrent buyers (qty=1 each): all succeed, against 5 distinct stock items", async () => {
    const { product } = sample; // buildSampleData already seeds 5 AVAILABLE rows
    expect(await countAvailableStock(prisma, product.id)).toBe(5);

    const buyers = await makeBuyers(5);
    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 1 })),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrderDirect>>> => r.status === "fulfilled",
    );
    // Surface WHY on failure — a plain length assertion loses the rejection reason.
    if (fulfilled.length !== 5) {
      const reasons = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason);
      throw new Error(`Expected all 5 concurrent buyers to succeed; got ${fulfilled.length}/5. Rejections: ${JSON.stringify(reasons)}`);
    }
    expect(fulfilled.length).toBe(5);

    const reserved = await prisma.stockItem.findMany({ where: { productId: product.id, status: "RESERVED" } });
    expect(reserved.length).toBe(5);
    expect(new Set(reserved.map((s) => s.id)).size).toBe(5); // 5 distinct stock rows
    expect(new Set(reserved.map((s) => s.orderId)).size).toBe(5); // 5 distinct orders

    expect(await countAvailableStock(prisma, product.id)).toBe(0);
    await assertNoDoubleReservation();
  });

  it("Case D — 1 available stock item, 5 concurrent buyers each requesting quantity=2 (individually over-stock): all fail cleanly, nothing reserved", async () => {
    const { product } = sample;
    await reduceStockTo(product.id, 1);

    const buyers = await makeBuyers(5);
    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 2 })),
    );

    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results as PromiseRejectedResult[]) {
      expect(r.reason).toMatchObject({ key: "error.out_of_stock" });
    }

    const reservedCount = await prisma.stockItem.count({ where: { productId: product.id, status: "RESERVED" } });
    expect(reservedCount).toBe(0);
  });
});
