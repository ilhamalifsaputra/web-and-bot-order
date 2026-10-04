/**
 * Backend audit E2 item 6: uniqueOrderCode checks a freshly generated code is
 * free and the order INSERT happens later, so a concurrent order can take the
 * same code in between. createOrderDirect/createOrderFromCart then caught that
 * unique violation and reported it as DuplicateCheckoutIntentError whenever
 * the caller had passed a checkoutIntentId — telling the buyer they had
 * double-tapped when they had not. Only a collision on checkout_intent_id is a
 * duplicate checkout.
 *
 * The code generator is pinned so the collision is deterministic; the race is
 * real: another transaction holds the same code uncommitted while the order
 * is created.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { OrderStatus } from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";

const PINNED_CODE = "ORD-PINNED-0001";
vi.mock("@app/core/formatters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/core/formatters")>();
  return { ...actual, generateOrderCode: () => PINNED_CODE };
});

const { createOrderDirect, DuplicateCheckoutIntentError } = await import("./orders");

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

describe("order code collision is not reported as a duplicate checkout", () => {
  it("a concurrent order taking the same order code fails as an order-code collision, not DuplicateCheckoutIntentError", async () => {
    // Warm a second pooled connection so the competing transaction is really concurrent.
    await Promise.all(
      [0, 1, 2].map(() =>
        prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT 1`;
          await new Promise((r) => setTimeout(r, 200));
        }),
      ),
    );

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const codeTaken = new Promise<void>((resolve) => (inserted = resolve));
    const competitor = prisma.$transaction(
      async (tx) => {
        await tx.order.create({
          data: {
            orderCode: PINNED_CODE,
            userId: sample.user.id,
            subtotalAmount: "1",
            totalAmount: "1",
            status: OrderStatus.PENDING_PAYMENT,
          },
        });
        inserted();
        await released;
      },
      { timeout: 15_000 },
    );
    await codeTaken;

    const attempt = prisma.$transaction(
      (tx) =>
        createOrderDirect(tx, {
          channel: "bot",
          user: sample.user,
          productId: sample.product.id,
          quantity: 1,
          checkoutIntentId: randomUUID(),
        }),
      { timeout: 15_000 },
    );
    await new Promise((r) => setTimeout(r, 500)); // the attempt is now blocked on the competitor's code
    release();
    await competitor;

    const outcome = await attempt.then(
      () => null,
      (e: unknown) => e,
    );
    expect(outcome).not.toBeNull();
    expect(outcome).not.toBeInstanceOf(DuplicateCheckoutIntentError);
  });
});
