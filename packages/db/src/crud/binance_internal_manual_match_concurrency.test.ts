/**
 * True-concurrency regression tests for the ops-panel actions on an UNMATCHED
 * Binance Internal Transfer ledger row: `manualMatchTx` and
 * `dismissUnmatchedTx`.
 *
 * Both used to read the ledger row, check `outcome === "unmatched"` in
 * application code, then `update` it by its unique key with no guard on the
 * outcome. Under Postgres READ COMMITTED two admins acting at the same instant
 * both read "unmatched", the second UPDATE simply waits for the first to
 * commit and then overwrites it — so one transfer could settle TWO orders
 * (money delivered twice for one payment), or a dismiss could silently erase a
 * match that had just delivered goods.
 *
 * These fire the competing calls at the same instant via `Promise.allSettled`
 * against the real dev Postgres; sequential awaits would prove nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [444] } };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, recordUnmatchedTx, manualMatchTx, dismissUnmatchedTx, bulkAddStock } from "@app/db";
import { OrderStatus, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let adminA: number;
let adminB: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  // Warm the pool so the concurrent interactive transactions below contend on
  // the ledger row, not on cold Postgres connection setup (see
  // wallet_concurrency.test.ts for the full reasoning).
  await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  // Enough stock that both orders could deliver if the race let them.
  await bulkAddStock(prisma, sample.product.id, ["extra-cred-1", "extra-cred-2", "extra-cred-3"]);
  // The acting admin is a users.id (stock events FK it), so make two real ones.
  const mk = (n: number) => prisma.user.create({ data: { telegramId: BigInt(900000 + n), referralCode: `adm${n}` } });
  adminA = (await mk(1)).id;
  adminB = (await mk(2)).id;
});

async function makePendingInternalOrder() {
  const order = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL } });
  return order;
}

describe("manualMatchTx under true Postgres concurrency", () => {
  it("two admins matching one unmatched transfer to two different orders: exactly one succeeds, only one order is paid", async () => {
    const a = await makePendingInternalOrder();
    const b = await makePendingInternalOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "tx-race-1", amount: a.totalAmount });

    const results = await Promise.allSettled([
      manualMatchTx(prisma, { binanceTxId: "tx-race-1", orderId: a.id, adminId: adminA }),
      manualMatchTx(prisma, { binanceTxId: "tx-race-1", orderId: b.id, adminId: adminB }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ValidationError);
    expect(rejected[0]!.reason).toMatchObject({ key: "error.tx_not_unmatched" });

    const orders = await prisma.order.findMany({ where: { id: { in: [a.id, b.id] } } });
    const stillPending = orders.filter((o) => o.status === OrderStatus.PENDING_PAYMENT);
    expect(stillPending.length).toBe(1);
    expect(orders.filter((o) => o.binanceTxid === "tx-race-1").length).toBe(1);

    const ledger = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "tx-race-1" } });
    expect(ledger.outcome).toBe("matched");
    const paid = orders.find((o) => o.status !== OrderStatus.PENDING_PAYMENT)!;
    expect(ledger.orderId).toBe(paid.id);
  });

  it("a match racing a dismiss: exactly one wins and the ledger row agrees with the order", async () => {
    const a = await makePendingInternalOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "tx-race-2", amount: a.totalAmount });

    const results = await Promise.allSettled([
      manualMatchTx(prisma, { binanceTxId: "tx-race-2", orderId: a.id, adminId: adminA }),
      dismissUnmatchedTx(prisma, "tx-race-2"),
    ]);

    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toMatchObject({ key: "error.tx_not_unmatched" });

    const ledger = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "tx-race-2" } });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    if (ledger.outcome === "dismissed") {
      expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
      expect(order.binanceTxid).toBeNull();
    } else {
      expect(ledger.outcome).toBe("matched");
      expect(ledger.orderId).toBe(a.id);
      expect(order.status).not.toBe(OrderStatus.PENDING_PAYMENT);
    }
  });

  it("two concurrent dismisses of the same row: exactly one succeeds", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "tx-race-3", amount: "10" });
    const results = await Promise.allSettled([dismissUnmatchedTx(prisma, "tx-race-3"), dismissUnmatchedTx(prisma, "tx-race-3")]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const ledger = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "tx-race-3" } });
    expect(ledger.outcome).toBe("dismissed");
  });

  it("sequential control: matching an already-matched row is refused", async () => {
    const a = await makePendingInternalOrder();
    const b = await makePendingInternalOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "tx-seq-1", amount: a.totalAmount });
    await manualMatchTx(prisma, { binanceTxId: "tx-seq-1", orderId: a.id, adminId: adminA });
    await expect(manualMatchTx(prisma, { binanceTxId: "tx-seq-1", orderId: b.id, adminId: adminA })).rejects.toMatchObject({
      key: "error.tx_not_unmatched",
    });
  });
});
