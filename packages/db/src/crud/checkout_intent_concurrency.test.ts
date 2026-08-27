/**
 * True-concurrency regression tests for the atomic checkoutIntentId guard
 * (Task A1) — the DB-enforced replacement for the bot's best-effort,
 * race-prone `refuseDuplicateCheckout` (apps/order-bot/src/handlers/
 * checkout.ts): two near-simultaneous "Buy Now" taps for the SAME checkout
 * attempt (same client-minted checkoutIntentId) must never both create an
 * Order row.
 *
 * Same technique as stock_concurrency.test.ts (Postgres migration
 * verification, Task 4): fire multiple `createOrderDirect`/
 * `createOrderFromCart` calls at the SAME instant via `Promise.allSettled`
 * against the real dev Postgres, which has actual concurrent writers — a
 * sequential, one-await-at-a-time pair of calls could never distinguish "the
 * unique constraint holds under a genuine race" from "the second call just
 * happened to run after the first committed".
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  createOrderFromCart,
  addToCart,
  upsertUser,
  DuplicateCheckoutIntentError,
  getOrderByCheckoutIntentId,
} from "@app/db";

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
 *  confound "N concurrent requests" with "session state reused". Mirrors
 *  stock_concurrency.test.ts's makeBuyers. */
async function makeBuyers(n: number) {
  const buyers = [];
  for (let i = 0; i < n; i++) {
    buyers.push(
      await upsertUser(prisma, { telegramId: 910000 + i, username: `intent-buyer-${i}`, fullName: `Intent Buyer ${i}` }),
    );
  }
  return buyers;
}

describe("createOrderDirect under true Postgres concurrency — checkoutIntentId collision", () => {
  it("5 concurrent buyers, SAME checkoutIntentId, ample stock: exactly 1 order is created, 4 reject with DuplicateCheckoutIntentError", async () => {
    const { product } = sample; // buildSampleData seeds 5 AVAILABLE stock rows — never the bottleneck here
    const buyers = await makeBuyers(5);
    const checkoutIntentId = randomUUID();

    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 1, checkoutIntentId })),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrderDirect>>> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(DuplicateCheckoutIntentError);
      expect((r.reason as DuplicateCheckoutIntentError).checkoutIntentId).toBe(checkoutIntentId);
    }

    // Exactly one Order row carries this checkoutIntentId, and it's the
    // winner's order — not a phantom row from a loser that half-committed.
    const winningOrder = fulfilled[0]!.value!;
    const rowCount = await prisma.order.count({ where: { checkoutIntentId } });
    expect(rowCount).toBe(1);
    const stamped = await getOrderByCheckoutIntentId(prisma, checkoutIntentId);
    expect(stamped?.id).toBe(winningOrder.id);
  });

  it("2 concurrent buyers, DIFFERENT checkoutIntentId each: both succeed independently (the constraint doesn't over-block)", async () => {
    const { product } = sample;
    const buyers = await makeBuyers(2);
    const intentA = randomUUID();
    const intentB = randomUUID();

    const results = await Promise.allSettled([
      createOrderDirect(prisma, { user: buyers[0]!, productId: product.id, quantity: 1, checkoutIntentId: intentA }),
      createOrderDirect(prisma, { user: buyers[1]!, productId: product.id, quantity: 1, checkoutIntentId: intentB }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.order.count({ where: { checkoutIntentId: intentA } })).toBe(1);
    expect(await prisma.order.count({ where: { checkoutIntentId: intentB } })).toBe(1);
  });

  it("omitting checkoutIntentId (existing callers, unaffected): two concurrent orders with no intent id both succeed", async () => {
    const { product } = sample;
    const buyers = await makeBuyers(2);

    const results = await Promise.allSettled(
      buyers.map((user) => createOrderDirect(prisma, { user, productId: product.id, quantity: 1 })),
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    // Both orders persist checkoutIntentId as null — no accidental collision
    // between two null values (a unique index treats NULLs as distinct).
    const orders = await prisma.order.findMany({ where: { userId: { in: buyers.map((b) => b.id) } } });
    expect(orders.every((o) => o.checkoutIntentId === null)).toBe(true);
  });

  it("sequential retry after a collision: the loser's own retry with a FRESH checkoutIntentId succeeds", async () => {
    const { product } = sample;
    const [buyerA, buyerB] = await makeBuyers(2);
    const checkoutIntentId = randomUUID();

    const first = await createOrderDirect(prisma, { user: buyerA!, productId: product.id, quantity: 1, checkoutIntentId });
    expect(first).not.toBeNull();

    await expect(
      createOrderDirect(prisma, { user: buyerB!, productId: product.id, quantity: 1, checkoutIntentId }),
    ).rejects.toBeInstanceOf(DuplicateCheckoutIntentError);

    // buyerB mints a new attempt (mirrors checkout.ts's notifyDuplicateCheckout
    // path — the bot never reuses the same checkoutIntentId after a collision).
    const retryIntentId = randomUUID();
    const retry = await createOrderDirect(prisma, { user: buyerB!, productId: product.id, quantity: 1, checkoutIntentId: retryIntentId });
    expect(retry).not.toBeNull();
    expect(await prisma.order.count({ where: { userId: buyerB!.id } })).toBe(1);
  });
});

describe("createOrderFromCart under true Postgres concurrency — checkoutIntentId collision", () => {
  it("5 concurrent buyers, SAME checkoutIntentId, ample stock: exactly 1 order is created, 4 reject with DuplicateCheckoutIntentError", async () => {
    const { product } = sample;
    const buyers = await makeBuyers(5);
    for (const user of buyers) {
      await addToCart(prisma, user.id, product.id, 1);
    }
    const checkoutIntentId = randomUUID();

    const results = await Promise.allSettled(
      buyers.map((user) => createOrderFromCart(prisma, { user, checkoutIntentId })),
    );

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createOrderFromCart>>> => r.status === "fulfilled",
    );
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(DuplicateCheckoutIntentError);
    }
    expect(await prisma.order.count({ where: { checkoutIntentId } })).toBe(1);
  });
});
