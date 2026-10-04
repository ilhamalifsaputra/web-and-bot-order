/**
 * Backend audit E2 item 4: allocateOneAvailableStock picked the lowest
 * AVAILABLE id and retried only 5 times when another transaction had claimed
 * it first. Every concurrent allocator aims at the same lowest row, so under
 * more than 5 concurrent checkouts a caller could lose 5 races in a row and
 * report out-of-stock while plenty of stock was still available.
 *
 * Real Postgres concurrency: each allocation runs in its own transaction that
 * stays open for a moment after reserving (as a real checkout does while it
 * finishes the order), so the others keep colliding on locked rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { allocateOneAvailableStock, bulkAddStock } from "@app/db";
import { OrderStatus, StockActorType, StockStatus } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb({ connectionLimit: 20 });
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

async function seedAvailable(total: number) {
  const denom = sample.product; // the denomination buildSampleData seeds stock for
  const seeded = await prisma.stockItem.count({ where: { productId: denom.id, status: StockStatus.AVAILABLE } });
  await bulkAddStock(
    prisma,
    denom.id,
    Array.from({ length: total - seeded }, (_, i) => `contention-${i}@x:pw`),
    sample.user.id,
  );
  return denom;
}

/**
 * Open enough pooled connections up front. Prisma opens them lazily, and on
 * this platform opening one can take seconds — a transaction started mid-test
 * would sit waiting for its connection until the race it is meant to join has
 * already finished, and the test would pass for the wrong reason.
 */
async function warmPool(n: number) {
  await Promise.all(
    Array.from({ length: n }, () =>
      prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await new Promise((r) => setTimeout(r, 300));
        },
        { maxWait: 30_000, timeout: 30_000 },
      ),
    ),
  );
}

function makeOrder(i: number) {
  return prisma.order.create({
    data: {
      orderCode: `ORD-CONTENTION-${i}`,
      userId: sample.user.id,
      subtotalAmount: "1",
      totalAmount: "1",
      status: OrderStatus.PENDING_PAYMENT,
    },
  });
}

describe("allocateOneAvailableStock under contention", () => {
  it("losing more than 5 races in a row to checkouts that commit one after another is not reported as out of stock", async () => {
    // Six other checkouts each hold one of the six lowest rows, reserved but
    // not yet committed, and finish one after another. The allocator aims at
    // the lowest row, waits for its holder, loses, aims at the next, and so on
    // — six lost races in a row while two rows were free the whole time.
    const denom = await seedAvailable(8);
    const ids = (
      await prisma.stockItem.findMany({
        where: { productId: denom.id, status: StockStatus.AVAILABLE },
        orderBy: { id: "asc" },
        select: { id: true },
      })
    ).map((r) => r.id);
    const holderOrders = [];
    for (let i = 0; i < 6; i++) holderOrders.push(await makeOrder(i));
    const order = await makeOrder(99);
    await warmPool(10);

    const gates: Array<() => void> = [];
    const holders = holderOrders.map((holderOrder, i) =>
      prisma.$transaction(
        async (tx) => {
          await tx.stockItem.updateMany({
            where: { id: ids[i]!, status: StockStatus.AVAILABLE },
            data: { status: StockStatus.RESERVED, orderId: holderOrder.id, reservedAt: new Date() },
          });
          // Indexed by row, so the holders release in row order below.
          await new Promise<void>((resolve) => (gates[i] = resolve));
        },
        { timeout: 30_000 },
      ),
    );
    while (gates.filter(Boolean).length < 6) await new Promise((r) => setTimeout(r, 20));

    const allocation = prisma.$transaction(
      (tx) => allocateOneAvailableStock(tx, denom.id, order.id, { type: StockActorType.SYSTEM }),
      { timeout: 30_000 },
    );
    // Let the holders finish one at a time, each after the allocator has had
    // time to move on to (and block on) the next row.
    for (const release of gates) {
      await new Promise((r) => setTimeout(r, 250));
      release();
    }
    await Promise.all(holders);
    const row = await allocation;

    expect(row).not.toBeNull();
    expect(ids.slice(6)).toContain(row!.id);
  });

  it("12 concurrent allocators on 12 available rows all get a distinct row — none reports a false out-of-stock", async () => {
    const N = 12;
    const denom = sample.product; // the denomination buildSampleData seeds stock for
    const seeded = await prisma.stockItem.count({ where: { productId: denom.id, status: StockStatus.AVAILABLE } });
    await bulkAddStock(
      prisma,
      denom.id,
      Array.from({ length: N - seeded }, (_, i) => `contention-${i}@x:pw`),
      sample.user.id,
    );
    expect(await prisma.stockItem.count({ where: { productId: denom.id, status: StockStatus.AVAILABLE } })).toBe(N);
    const orders = [];
    for (let i = 0; i < N; i++) {
      orders.push(
        await prisma.order.create({
          data: {
            orderCode: `ORD-CONTENTION-${i}`,
            userId: sample.user.id,
            subtotalAmount: "1",
            totalAmount: "1",
            status: OrderStatus.PENDING_PAYMENT,
          },
        }),
      );
    }
    await warmPool(N);

    const results = await Promise.allSettled(
      orders.map((order) =>
        prisma.$transaction(
          async (tx) => {
            const row = await allocateOneAvailableStock(tx, denom.id, order.id, { type: StockActorType.SYSTEM });
            // Keep the reservation uncommitted for a moment, like a checkout
            // still writing the rest of its order.
            await new Promise((r) => setTimeout(r, 300));
            return row;
          },
          { timeout: 30_000, maxWait: 30_000 },
        ),
      ),
    );

    const rows = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(0);
    expect(rows.filter((row) => row === null)).toHaveLength(0);
    expect(new Set(rows.map((row) => row!.id)).size).toBe(N);
    expect(await prisma.stockItem.count({ where: { productId: denom.id, status: StockStatus.RESERVED } })).toBe(N);
  });

  it("still returns null when the product is genuinely out of stock", async () => {
    const denom = sample.product;
    await prisma.stockItem.updateMany({ where: { productId: denom.id }, data: { status: StockStatus.SOLD } });
    const order = await prisma.order.create({
      data: { orderCode: "ORD-EMPTY", userId: sample.user.id, subtotalAmount: "1", totalAmount: "1", status: OrderStatus.PENDING_PAYMENT },
    });
    expect(await allocateOneAvailableStock(prisma, denom.id, order.id, { type: StockActorType.SYSTEM })).toBeNull();
  });
});
