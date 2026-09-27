/**
 * creditOrderToBalance — add a paid-but-unfulfillable order's external payment
 * to the buyer's credit balance (store credit) in the order's currency, then
 * void the order (CANCELLED, never REFUNDED).
 *
 * Covered: credits the correct currency + amount, marks CANCELLED, is
 * idempotent on retry, and re-tags a linked processed_binance_tx row to the
 * `credited_to_balance` outcome when a binanceTxId is passed.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  adjustWallet,
  cancelOrder,
  createOrderDirect,
  createInternalOrder,
  creditOrderToBalance,
  createWalletTopupOrder,
  deliverPaidTokopayOrder,
  getOrder,
} from "@app/db";
import { PaymentMethod } from "@app/core/enums";
import { markUnderpaid } from "./binance_internal";
import { markUnderpaidBybit } from "./bybit_deposit";
import { Decimal } from "@app/core/money";
import { StockActorType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
/** A REAL admin row, not a literal: releasing the order's stock reservation
 *  writes a StockItemEvent whose actorAdminId is a real FK to User (Fase 3b),
 *  unlike WalletTransaction.adminId, which is a plain nullable Int. */
let adminId: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  await prisma.walletTransaction.deleteMany();
  await prisma.processedBinanceTx.deleteMany();
  await prisma.processedTokopayTx.deleteMany();
  await prisma.processedBybitTx.deleteMany();
  await prisma.qrisUnderpaidTx.deleteMany();
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({
    data: { telegramId: BigInt(880_000_000 + Math.floor(Math.random() * 1_000_000)), referralCode: `credit-admin-${Math.random()}`, role: "ADMIN" },
  });
  adminId = admin.id;
});

const balances = (userId: number) =>
  prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { walletBalance: true, walletBalanceUsdt: true },
  });

describe("creditOrderToBalance", () => {
  it("credits the IDR balance with the paid amount and marks the order CANCELLED", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!; // 5.00 IDR total, currency IDR

    const before = await balances(user.id);
    const res = await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    expect(res.currency).toBe("IDR");
    expect(new Decimal(res.credited).equals(order.totalAmount)).toBe(true);

    const after = await balances(user.id);
    expect(Number(after.walletBalance) - Number(before.walletBalance)).toBeCloseTo(
      Number(order.totalAmount),
    );
    expect(Number(after.walletBalanceUsdt)).toBeCloseTo(Number(before.walletBalanceUsdt)); // USDT untouched

    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");
    const history = await prisma.orderStatusHistory.findMany({ where: { orderId: order.id } });
    expect(history).toHaveLength(1);
    expect(history[0]!.status).toBe("CANCELLED");

    const led = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    expect(led.currency).toBe("IDR");
    expect(led.adminId).toBe(adminId);
  });

  it("credits the USDT balance for a USDT order — IDR untouched", async () => {
    const { user, product } = sample;
    const created = await prisma.$transaction((tx) =>
      createInternalOrder(tx, {
        user: { id: user.id, role: user.role },
        productId: product.id,
        quantity: 1,
        rate: 1, // USDT total ≈ 5.00
      }),
    );
    const order = (await getOrder(prisma, created!.id))!;
    expect(order.currency).toBe("USDT");

    const before = await balances(user.id);
    const res = await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    expect(res.currency).toBe("USDT");
    const after = await balances(user.id);
    expect(Number(after.walletBalanceUsdt) - Number(before.walletBalanceUsdt)).toBeCloseTo(
      Number(order.totalAmount),
    );
    expect(Number(after.walletBalance)).toBeCloseTo(Number(before.walletBalance)); // IDR untouched
    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");

    const led = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    expect(led.currency).toBe("USDT");
  });

  it("credits an explicit amount when provided", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    const before = await balances(user.id);
    await creditOrderToBalance(prisma, { orderId: order.id, amount: "3.00", adminId });
    const after = await balances(user.id);
    expect(Number(after.walletBalance) - Number(before.walletBalance)).toBeCloseTo(3);
  });

  it("is idempotent — a retry does not double-credit", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    await creditOrderToBalance(prisma, { orderId: order.id, adminId });
    const after1 = await balances(user.id);

    // The first call leaves the order CANCELLED, which is no longer terminal to
    // this function (an already-cancelled order can still be credited once), so
    // the retry is refused by the more precise double-credit guard instead.
    await expect(
      creditOrderToBalance(prisma, { orderId: order.id, adminId }),
    ).rejects.toMatchObject({ key: "error.already_credited" });

    const after2 = await balances(user.id);
    expect(Number(after2.walletBalance)).toBeCloseTo(Number(after1.walletBalance));
    expect(
      await prisma.walletTransaction.count({
        where: { orderId: order.id, reason: "unfulfilled_credit" },
      }),
    ).toBe(1);
  });

  it("re-tags a linked processed_binance_tx row as credited_to_balance", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: "CTX-1", amount: new Decimal("5.00"), outcome: "unmatched" },
    });

    await creditOrderToBalance(prisma, {
      orderId: order.id,
      amount: "5.00",
      adminId,
      binanceTxId: "CTX-1",
    });

    const row = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "CTX-1" } });
    expect(row.outcome).toBe("credited_to_balance");
    expect(row.orderId).toBe(order.id);
  });
});

/**
 * Crediting an order that something else (the expiry sweep, the buyer, an
 * admin) already CANCELLED — the only admin action that can produce the "money
 * went back" proof `cancelledOrderIdsWithMoneyReturned` looks for once the
 * order is already cancelled.
 */
describe("creditOrderToBalance on an already-CANCELLED order", () => {
  /** A PENDING_PAYMENT order (a gateway settle whose delivery threw leaves the
   *  order exactly here, with no paidAt) cancelled by the expiry sweep.
   *
   *  `paid` (default true) links a gateway ledger row to the order first — what
   *  `deliverPaidTokopayOrder` leaves behind when it claimed the payment for this
   *  order and the delivery transaction then threw: the row keeps its `orderId`
   *  and is flagged `delivery_failed`, while the order's own `paidAt` write rolled
   *  back. `paid: false` is the ordinary abandoned checkout: no payment ever
   *  arrived, so no ledger row points at the order. */
  async function cancelledOrder(opts: { walletAmount?: string; voucherCode?: string; paid?: boolean } = {}) {
    const { user, product } = sample;
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role, walletBalance: fresh.walletBalance },
      productId: product.id,
      quantity: 1,
      voucherCode: opts.voucherCode ?? null,
      walletAmount: opts.walletAmount,
    }))!;
    if (opts.paid ?? true) {
      await prisma.processedTokopayTx.create({
        data: { trxId: `TP-${order.id}`, orderId: order.id, amount: order.totalAmount, outcome: "delivery_failed" },
      });
    }
    await cancelOrder(prisma, order.id, "expired", { type: StockActorType.SYSTEM });
    const cancelled = (await getOrder(prisma, order.id))!;
    expect(cancelled.status).toBe("CANCELLED");
    return cancelled;
  }

  it("credits the paid amount without re-running the cancel's hold release or status transition", async () => {
    const { user, voucher } = sample;
    await adjustWallet(prisma, user.id, "2", { reason: "admin_adjust" });
    const usedBefore = (await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedCount;

    const order = await cancelledOrder({ walletAmount: "1", voucherCode: voucher.code });
    expect(new Decimal(order.walletUsed).greaterThan(0)).toBe(true);
    expect(order.voucherId).toBe(voucher.id);
    expect(new Decimal(order.totalAmount).greaterThan(0)).toBe(true);
    // Checkout took one voucher use and the cancel gave it back.
    const usedAfterCancel = (await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedCount;
    expect(usedAfterCancel).toBe(usedBefore);

    const historyAfterCancel = await prisma.orderStatusHistory.count({ where: { orderId: order.id } });
    const before = await balances(user.id);

    const res = await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    expect(new Decimal(res.credited).equals(order.totalAmount)).toBe(true);
    const after = await balances(user.id);
    // Only the external payment: the walletUsed portion already went back at the cancel.
    expect(new Decimal(after.walletBalance).minus(before.walletBalance).equals(order.totalAmount)).toBe(true);

    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");
    // transitionOrderStatus was skipped: no second CANCELLED history row.
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(historyAfterCancel);
    // releaseOrderHolds was skipped: the walletUsed portion went back exactly once.
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "order_refund" } })).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(1);
    // Net voucher movement across checkout + cancel + credit is exactly the one
    // decrement the cancel made — the credit did not decrement it again.
    const usedAfter = (await prisma.voucher.findUniqueOrThrow({ where: { id: voucher.id } })).usedCount;
    expect(usedAfter).toBe(usedAfterCancel);
  });

  // The Critical finding: a CANCELLED order that was never paid (an abandoned
  // checkout the expiry sweep cancelled) has no money to hand back — crediting
  // it would mint wallet balance out of nothing.
  it("refuses to credit a cancelled order that was never paid, with error.order_never_paid", async () => {
    const order = await cancelledOrder({ paid: false });
    const before = await balances(sample.user.id);

    await expect(creditOrderToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject({
      key: "error.order_never_paid",
    });
    expect((await balances(sample.user.id)).walletBalance.toString()).toBe(before.walletBalance.toString());
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(0);
  });

  // paidAt stays null in the delivery-failed scenario (the settle transaction
  // rolled back), so the linked ledger row is the only proof money arrived.
  it("credits a cancelled order with no paidAt whose gateway ledger row is linked to it", async () => {
    const order = await cancelledOrder({ paid: true });
    expect(order.paidAt).toBeNull();
    const before = await balances(sample.user.id);

    await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    const after = await balances(sample.user.id);
    expect(new Decimal(after.walletBalance).minus(before.walletBalance).equals(order.totalAmount)).toBe(true);
  });

  // Any of the five gateway tables counts, not just TokoPay.
  it("accepts a linked ledger row from another gateway (Bybit) as proof of payment", async () => {
    const order = await cancelledOrder({ paid: false });
    await prisma.processedBybitTx.create({
      data: { bybitTxId: `BY-${order.id}`, orderId: order.id, amount: order.totalAmount, outcome: "delivery_failed" },
    });
    await expect(creditOrderToBalance(prisma, { orderId: order.id, adminId })).resolves.toBeTruthy();
  });

  // POST /api/payments/credit: the admin attaches a specific, already-verified
  // transaction that is not linked to the order yet — the linking happens in
  // this same call — so the passed binanceTxId is itself the evidence.
  it("credits a never-linked cancelled order when a binanceTxId is passed, and links that row", async () => {
    const order = await cancelledOrder({ paid: false });
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: "CTX-CANCELLED", amount: order.totalAmount, outcome: "unmatched" },
    });

    await creditOrderToBalance(prisma, { orderId: order.id, adminId, binanceTxId: "CTX-CANCELLED" });

    const row = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "CTX-CANCELLED" } });
    expect(row.outcome).toBe("credited_to_balance");
    expect(row.orderId).toBe(order.id);
  });

  // Re-review finding 3: the evidence row must be CONSUMED by the credit, not
  // just read. Left at delivery_failed/unmatched it stays reclaimable by the
  // gateways' own settle paths, which would pay the same money out again.
  it("consumes the evidence ledger row: it is re-tagged credited_to_balance", async () => {
    const order = await cancelledOrder();
    await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    const row = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: `TP-${order.id}` } });
    expect(row.outcome).toBe("credited_to_balance");
    expect(row.orderId).toBe(order.id);
  });

  it("consumes evidence rows in every gateway table linked to the order (Bybit too)", async () => {
    const order = await cancelledOrder();
    await prisma.processedBybitTx.create({
      data: { bybitTxId: `BY-${order.id}`, orderId: order.id, amount: order.totalAmount, outcome: "unmatched" },
    });
    await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: `TP-${order.id}` } })).outcome).toBe(
      "credited_to_balance",
    );
    expect((await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: `BY-${order.id}` } })).outcome).toBe(
      "credited_to_balance",
    );
  });

  // The end-to-end double-credit this closes: a cancelled QRIS wallet top-up is
  // still late-settleable (isLateSettleableWalletTopup), so a duplicate/retried
  // TokoPay callback for the same trxId would reclaim a still-delivery_failed
  // row and credit `wallet_topup` on top of the admin's `unfulfilled_credit`.
  it("a later duplicate TokoPay callback cannot settle a credited cancelled top-up a second time", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    const trxId = `TP-topup-${order.id}`;
    await prisma.processedTokopayTx.create({
      data: { trxId, orderId: order.id, amount: order.totalAmount, outcome: "delivery_failed" },
    });
    await cancelOrder(prisma, order.id, "expired", { type: StockActorType.SYSTEM });
    const before = await balances(sample.user.id);

    await creditOrderToBalance(prisma, { orderId: order.id, adminId });
    const result = await deliverPaidTokopayOrder(prisma, { orderId: order.id, trxId, amount: order.totalAmount });

    expect(result.status).toBe("already_processed");
    const after = await balances(sample.user.id);
    expect(new Decimal(after.walletBalance).minus(before.walletBalance).equals(order.totalAmount)).toBe(true);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "wallet_topup" } })).toBe(0);
    expect((await getOrder(prisma, order.id))!.status).toBe("CANCELLED");
  });

  it("refuses to credit a cancelled order a second time", async () => {
    const order = await cancelledOrder();
    await creditOrderToBalance(prisma, { orderId: order.id, adminId });
    const after1 = await balances(sample.user.id);

    await expect(creditOrderToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject({
      key: "error.already_credited",
    });
    expect((await balances(sample.user.id)).walletBalance.toString()).toBe(after1.walletBalance.toString());
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(1);
  });

  it("refuses to credit a cancelled order that already has a COMPLETED refund", async () => {
    const order = await cancelledOrder();
    await prisma.refund.create({ data: { orderId: order.id, amount: "1", currency: "IDR", status: "COMPLETED" } });
    const before = await balances(sample.user.id);

    await expect(creditOrderToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject({
      key: "error.order_already_refunded",
    });
    expect((await balances(sample.user.id)).walletBalance.toString()).toBe(before.walletBalance.toString());
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(0);
  });

  // Same evidence line reports.test.ts draws for "still counts as actionable":
  // a refund not yet paid out, or a wallet movement that isn't the credit.
  it("still credits a cancelled order whose only evidence is an unpaid refund or a non-credit wallet movement", async () => {
    const pendingRefund = await cancelledOrder();
    await prisma.refund.create({ data: { orderId: pendingRefund.id, amount: "1", currency: "IDR", status: "PENDING" } });
    const walletUsedBack = await cancelledOrder();
    await prisma.walletTransaction.create({
      data: { userId: sample.user.id, delta: "1", balanceAfter: "1", reason: "order_refund", orderId: walletUsedBack.id },
    });

    await expect(creditOrderToBalance(prisma, { orderId: pendingRefund.id, adminId })).resolves.toBeTruthy();
    await expect(creditOrderToBalance(prisma, { orderId: walletUsedBack.id, adminId })).resolves.toBeTruthy();
    expect(
      await prisma.walletTransaction.count({
        where: { orderId: { in: [pendingRefund.id, walletUsedBack.id] }, reason: "unfulfilled_credit" },
      }),
    ).toBe(2);
  });

  // Regression guard (re-review Critical): an UNDERPAID order an admin cancelled
  // through the underpaid-cancel route (POST /api/payments/:id/cancel, reason
  // `underpaid_cancelled`) keeps its linked `underpaid` ledger row, which
  // records only the PART that arrived. Taking that row as proof of payment
  // would credit the full totalAmount, minting the shortfall; underpaid orders
  // resolve through their own flows, never this one.
  it("refuses a cancelled UNDERPAID order whose only ledger row is the underpaid one (Binance and Bybit)", async () => {
    const { user, product } = sample;
    const flaggers = [
      (orderId: number) => markUnderpaid(prisma, { orderId, binanceTxId: `BN-under-${orderId}`, amount: "2" }),
      (orderId: number) => markUnderpaidBybit(prisma, { orderId, bybitTxId: `BY-under-${orderId}`, amount: "2" }),
    ];
    for (const flag of flaggers) {
      const created = await prisma.$transaction((tx) =>
        createInternalOrder(tx, { user: { id: user.id, role: user.role }, productId: product.id, quantity: 1, rate: 1 }),
      );
      expect(await flag(created!.id)).toBe(true);
      expect((await getOrder(prisma, created!.id))!.status).toBe("UNDERPAID");
      // Same call the underpaid-cancel route makes.
      await cancelOrder(prisma, created!.id, `underpaid_cancelled by admin_id=${adminId}`, {
        type: StockActorType.ADMIN,
        adminId,
      });
      expect((await getOrder(prisma, created!.id))!.status).toBe("CANCELLED");
      const before = await balances(user.id);

      await expect(creditOrderToBalance(prisma, { orderId: created!.id, adminId })).rejects.toMatchObject({
        key: "error.order_never_paid",
      });
      expect((await balances(user.id)).walletBalanceUsdt.toString()).toBe(before.walletBalanceUsdt.toString());
      expect(
        await prisma.walletTransaction.count({ where: { orderId: created!.id, reason: "unfulfilled_credit" } }),
      ).toBe(0);
    }
  });

  it("still refuses a DELIVERED order with error.order_terminal", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, {
      user: { id: user.id, role: user.role },
      productId: product.id,
      quantity: 1,
    }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: "DELIVERED" } });

    await expect(creditOrderToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject({
      key: "error.order_terminal",
    });
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(0);
  });

  // True Postgres concurrency, same two-PrismaClient shape as
  // refundExecution.test.ts section 9 (see its header for why two interactive
  // transactions from ONE client never actually overlap). Without the order-row
  // lock the loser still could not double-credit — the (orderId, reason) unique
  // index rejects its insert — but it would fail with a raw unique-violation
  // instead of the clean error.already_credited an admin UI can render.
  describe("under true Postgres concurrency", () => {
    async function connectRivalClient(): Promise<PrismaClient> {
      const baseUrl = process.env.DATABASE_URL_PRISMA;
      if (!baseUrl) throw new Error("DATABASE_URL_PRISMA must be set to a Postgres connection string for tests.");
      const rows = await prisma.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
      const url = new URL(baseUrl);
      url.searchParams.set("schema", rows[0]!.schema);
      const rival = new PrismaClient({ datasourceUrl: url.toString() });
      // Connect before the race so the rival waits on the row lock, not a handshake.
      await prisma.$queryRaw`SELECT 1`;
      await rival.$queryRaw`SELECT 1`;
      return rival;
    }

    it("two concurrent credits of the same cancelled order: exactly one credit lands", async () => {
      const order = await cancelledOrder();
      const before = await balances(sample.user.id);
      const rival = await connectRivalClient();
      try {
        // Raised maxWait/timeout: the loser blocks on the winner's row lock for
        // the winner's whole transaction, which counts against its own budget.
        const credit = (client: PrismaClient) =>
          client.$transaction((tx) => creditOrderToBalance(tx, { orderId: order.id, adminId }), {
            maxWait: 30_000,
            timeout: 60_000,
          });

        const results = await Promise.allSettled([credit(prisma), credit(rival)]);
        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect(rejected[0]!.reason).toBeInstanceOf(ValidationError);
        expect((rejected[0]!.reason as ValidationError).key).toBe("error.already_credited");

        expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "unfulfilled_credit" } })).toBe(1);
        const after = await balances(sample.user.id);
        expect(new Decimal(after.walletBalance).minus(before.walletBalance).equals(order.totalAmount)).toBe(true);
      } finally {
        await rival.$disconnect();
      }
    }, 60_000);
  });
});
