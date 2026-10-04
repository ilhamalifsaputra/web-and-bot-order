/**
 * Backend audit E2 item 6: check-then-insert paths whose unique violation was
 * either mis-read or surfaced raw under real concurrency.
 *  - upsertUser: two first contacts from one Telegram account both found no
 *    user and both inserted; the loser hit the telegram_id unique index, read
 *    it as a referral-code collision, retried five times and threw "Could not
 *    generate a unique referral code".
 *  - addToCart: two concurrent first adds of one product both found no line;
 *    the loser threw a raw P2002 (and two concurrent increments could lose one).
 *
 * Real Postgres concurrency via Promise.allSettled.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { upsertUser, addToCart } from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb({ connectionLimit: 12 });
  prisma = db.prisma;
  // Open the pooled connections up front: opening one lazily can take
  // seconds, which would quietly serialize the "concurrent" calls below.
  await Promise.all(
    Array.from({ length: 8 }, () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1`;
        await new Promise((r) => setTimeout(r, 300));
      }),
    ),
  );
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

describe("upsertUser — concurrent first contact", () => {
  it("5 simultaneous first contacts from one Telegram account all resolve to the same single user", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        upsertUser(prisma, { telegramId: 777_000_111, username: "racer", fullName: "Racer" }),
      ),
    );

    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
    }
    const ids = new Set(results.map((r) => (r as PromiseFulfilledResult<{ id: number }>).value.id));
    expect(ids.size).toBe(1);
    expect(await prisma.user.count({ where: { telegramId: 777_000_111n } })).toBe(1);
  });
});

describe("addToCart — concurrent adds of one product", () => {
  it("5 simultaneous first adds of one product leave one line holding all 5 units", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => addToCart(prisma, sample.user.id, sample.product.id, 1)),
    );

    for (const r of results) {
      if (r.status === "rejected") throw r.reason;
    }
    const lines = await prisma.cartItem.findMany({ where: { userId: sample.user.id, productId: sample.product.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(5);
  });

  it("still caps a line at 99 units when incrementing", async () => {
    await addToCart(prisma, sample.user.id, sample.product.id, 98);
    const row = await addToCart(prisma, sample.user.id, sample.product.id, 5);
    expect(row.quantity).toBe(99);
  });
});
