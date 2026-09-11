/**
 * True-concurrency regression tests for `adjustWallet` (./users.ts) — the
 * single chokepoint every wallet balance mutation in this codebase goes
 * through (checkout debits, admin adjustments, referral commissions, refunds,
 * top-ups).
 *
 * `adjustWallet` reads the current balance, computes the new one in
 * application code, and writes it back. Under SQLite — whose connection pool
 * was pinned to 1, serializing every writer in the process — that sequence was
 * accidentally race-free: there was never a second writer to interleave with.
 * Postgres has genuine concurrent writers, so two simultaneous calls for the
 * same user could both read the same pre-mutation balance, both pass their own
 * insufficient-funds check, and the one that commits its UPDATE last would
 * silently overwrite the other's movement — a lost update, i.e. a double-spend
 * on debits and a lost credit on top-ups.
 *
 * Every existing wallet test (wallet.test.ts, wallet_checkout.test.ts,
 * wallet_order_routing.test.ts) calls `adjustWallet` sequentially, one `await`
 * at a time, so none of them can see that. These tests fire several calls for
 * the SAME user at the SAME instant via `Promise.allSettled` against the real
 * dev Postgres, through the BARE `prisma` client — the vulnerable path, a
 * caller that is not already inside its own transaction — and assert on the
 * state after they all settle. Sequential awaits here would prove nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { adjustWallet } from "./users";

/** How many calls each concurrent burst below fires at once. */
const CONCURRENCY = 8;

let db: TestDb;
let prisma: PrismaClient;
let userId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  // Open CONCURRENCY pooled connections up front. A fresh PrismaClient starts
  // with an empty pool, and on this stack each new Postgres backend costs
  // several hundred milliseconds to establish — so a cold burst of concurrent
  // interactive transactions spends its whole `maxWait` (2s by default) queued
  // on connection setup and fails with P2028 before it ever reaches the row
  // lock. That is connection latency, not the contention these tests are
  // about. Holding them all open at once is what forces the pool to grow;
  // sequential warm-up queries would just reuse one connection.
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`),
  );
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // Order → User is onDelete: Restrict, so orders have to go before users.
  await prisma.walletTransaction.deleteMany();
  await prisma.order.deleteMany();
  await prisma.user.deleteMany();
  const u = await prisma.user.create({
    data: {
      telegramId: BigInt(Math.floor(Math.random() * 1e15)),
      referralCode: `r${Math.random()}`,
      walletBalance: "0",
    },
  });
  userId = u.id;
});

/** The user's committed IDR balance, as a Decimal. */
async function balance(): Promise<Decimal> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return new Decimal(u.walletBalance.toString());
}

/**
 * The ledger must be able to reconstruct the balance on its own: summing every
 * applied movement has to land exactly on the committed balance. A lost update
 * breaks this even when the row count looks right, because the overwritten
 * caller's ledger row records money that never reached the balance.
 */
async function assertLedgerReconciles(startingBalance: Decimal) {
  const rows = await prisma.walletTransaction.findMany({ where: { userId, currency: "IDR" } });
  const summedDeltas = rows.reduce((acc, r) => acc.plus(new Decimal(r.delta.toString())), new Decimal(0));
  const finalBalance = await balance();
  expect(summedDeltas.toString()).toBe(finalBalance.minus(startingBalance).toString());
}

describe("adjustWallet under true Postgres concurrency", () => {
  it("Case A — 8 concurrent credits for one user: every credit applies, none is lost", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        adjustWallet(prisma, userId, "10", { reason: "admin_adjust", note: `credit ${i}` }),
      ),
    );

    // Surface WHY on failure — a plain length assertion loses the rejection reason.
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length > 0) {
      throw new Error(
        `Expected all ${CONCURRENCY} concurrent credits to succeed; ${rejected.length} rejected: ${JSON.stringify(rejected.map((r) => r.reason))}`,
      );
    }

    expect((await balance()).toString()).toBe("80");
    const rows = await prisma.walletTransaction.findMany({ where: { userId } });
    expect(rows.length).toBe(CONCURRENCY);
    // Each movement saw a distinct running balance: 10, 20, … 80. A lost update
    // shows up here as two rows claiming the same balanceAfter.
    expect(rows.map((r) => Number(r.balanceAfter)).sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    await assertLedgerReconciles(new Decimal(0));
  });

  it("Case B — 8 concurrent debits against a balance that only covers 5: exactly 5 apply, the balance never goes negative", async () => {
    await adjustWallet(prisma, userId, "50", { reason: "admin_adjust" });
    const starting = await balance();
    expect(starting.toString()).toBe("50");

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        adjustWallet(prisma, userId, "-10", { reason: "order_payment", note: `debit ${i}` }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(5);
    expect(rejected.length).toBe(3);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ValidationError);
      expect(r.reason).toMatchObject({ key: "error.insufficient_wallet" });
    }

    expect((await balance()).toString()).toBe("0");
    // A rejected overdraw leaves no ledger row behind — the guard runs before
    // any money (or ledger) is written, concurrency or not.
    expect(await prisma.walletTransaction.count({ where: { userId, reason: "order_payment" } })).toBe(5);
    await assertLedgerReconciles(new Decimal(0));
  });

  it("Case C — concurrent credits and debits mixed: the balance equals the sum of every applied delta", async () => {
    await adjustWallet(prisma, userId, "100", { reason: "admin_adjust" });
    const starting = await balance();

    // All eight are individually affordable against the starting 100, so all
    // eight must apply regardless of the order they interleave in.
    const deltas = ["25", "-10", "40", "-30", "15", "-5", "60", "-20"];
    const results = await Promise.allSettled(
      deltas.map((d, i) => adjustWallet(prisma, userId, d, { reason: "admin_adjust", note: `mixed ${i}` })),
    );

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected.length > 0) {
      throw new Error(
        `Expected all ${deltas.length} mixed movements to succeed; ${rejected.length} rejected: ${JSON.stringify(rejected.map((r) => r.reason))}`,
      );
    }

    const expected = deltas.reduce((acc, d) => acc.plus(new Decimal(d)), starting);
    expect((await balance()).toString()).toBe(expected.toString()); // 175
    await assertLedgerReconciles(new Decimal(0));
  });

  it("Case D — concurrent duplicate movements for the same order and reason: exactly one applies", async () => {
    // The UNIQUE(orderId, reason) guard on wallet_transactions is what stops a
    // retried webhook crediting one order twice. wallet.test.ts pins it for
    // sequential calls; this pins that concurrency cannot slip a second
    // movement past it, and that a rejected duplicate moves no money at all.
    const order = await prisma.order.create({
      data: { orderCode: `ORD-${Math.random()}`, userId, subtotalAmount: "5", totalAmount: "5" },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        adjustWallet(prisma, userId, "100", { reason: "wallet_topup", orderId: order.id }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(results.filter((r) => r.status === "rejected").length).toBe(4);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(1);
    expect((await balance()).toString()).toBe("100");
    await assertLedgerReconciles(new Decimal(0));
  });

  it("Case E — sanity control: a single non-concurrent call still behaves exactly as before", async () => {
    const newBalance = await adjustWallet(prisma, userId, "12.5", { reason: "admin_adjust", adminId: 7 });
    expect(newBalance.toString()).toBe("12.5");
    expect((await balance()).toString()).toBe("12.5");
    const row = await prisma.walletTransaction.findFirstOrThrow({ where: { userId } });
    expect(row.delta.toString()).toBe("12.5");
    expect(row.balanceAfter.toString()).toBe("12.5");
    expect(row.adminId).toBe(7);
  });
});
