/**
 * `executeRefund` (Financial Ledger M4) — the first general-purpose refund
 * PAYOUT path in this shop. Everything the Refund domain could do before this
 * was record-keeping: `transitionRefundStatus` reaching COMPLETED explicitly
 * moves no money (it demands `acknowledgeNoPayout`), and the one real payout
 * that existed, `refundUnderpaidOrder`, is a narrow crypto-shortfall mechanism
 * that writes its own Refund row and never touches the state machine.
 *
 * So these tests are the only thing standing between a buyer who is owed money
 * and a payout that silently does not happen. Four properties get asserted
 * everywhere, because each fails silently:
 *
 * 1. **The money really moved.** A `RefundExecution` row marked COMPLETED next
 *    to an unchanged wallet balance is worse than no row at all — it is a
 *    written claim that the buyer was paid.
 * 2. **A second execution on the same order still works.** `WalletTransaction`
 *    is UNIQUE on `(orderId, reason)`, so passing an `orderId` for the
 *    `refund_execution` reason would make the SECOND legitimate refund on an
 *    order (a second bad unit found later, a retried attempt) throw a unique
 *    violation — a real payout failure for a customer who is owed money. The
 *    fix is `orderId: null`, and the test named "two WALLET executions against
 *    the same order" is the one that proves it; it is the single most important
 *    test in this file.
 * 3. **Ledger direction.** Which account is debited decides the SIGN of every
 *    number a future report shows, and a wrong direction leaves the trial
 *    balance perfectly balanced with the revenue figure wrong — the one error
 *    class a balance check cannot find. Both branches of the
 *    revenue-was-recognised rule are exercised, and WALLET vs MANUAL_TRANSFER
 *    credit two genuinely different accounts (`wallet_liability` vs `cash`).
 * 4. **`Order.status` only moves on a FULL refund.** Flipping a
 *    partially-refunded order to REFUNDED would terminate an order that still
 *    has live obligations against it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  FinancialTransactionType,
  OrderStatus,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  approveOrder,
  attachPaymentProof,
  createOrderDirect,
  createRefund,
  executeRefund,
  getOrder,
  transitionRefundStatus,
  WALLET_TX_REASONS,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

/**
 * The acting admin for every `executedBy` argument below. A real User row, not
 * a literal id: `audit_logs.admin_id` is a foreign key, and every function
 * under test here audits itself.
 */
let ADMIN_ID: number;

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
  const admin = await prisma.user.create({
    data: {
      telegramId: 9_000_000_001,
      username: "refund-admin",
      fullName: "Refund Admin",
      role: "ADMIN",
      referralCode: `ra${Math.random()}`,
    },
  });
  ADMIN_ID = admin.id;
});

// ── Fixture builders ───────────────────────────────────────────────────────

/** A raw, never-settled order (PENDING_PAYMENT): no ORDER_PAYMENT was posted
 *  for it, which is the second branch of the revenue-was-recognised rule. */
async function makeUnsettledOrder() {
  const order = await createOrderDirect(prisma, {
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
  });
  return (await getOrder(prisma, order!.id))!;
}

/**
 * A DELIVERED order whose payment WAS posted to the ledger — the ordinary case
 * a refund follows. Built through the same createOrderDirect →
 * attachPaymentProof → approveOrder path a real buyer walks, so the
 * ORDER_PAYMENT posting `executeRefund` branches on is a real one.
 */
async function makeDeliveredOrder() {
  const order = await makeUnsettledOrder();
  await attachPaymentProof(prisma, order.id, { fileId: "proof", txid: `TX-${order.id}` });
  await approveOrder(prisma, order.id, { adminId: ADMIN_ID });
  const delivered = (await getOrder(prisma, order.id))!;
  expect(delivered.status).toBe(OrderStatus.DELIVERED);
  return delivered;
}

/** A Refund sitting in PROCESSING — the only state `executeRefund` accepts. */
async function makeProcessingRefund(orderId: number, amount: Decimal.Value, currency = "IDR") {
  const refund = await createRefund(prisma, { orderId, amount, currency, adminId: ADMIN_ID });
  await transitionRefundStatus(prisma, {
    refundId: refund.id,
    from: RefundStatus.PENDING,
    to: RefundStatus.PROCESSING,
    adminId: ADMIN_ID,
  });
  return refund;
}

// ── Assertion helpers ──────────────────────────────────────────────────────

/** One posting's entries, flattened into a readable shape. */
async function entriesOf(financialTransactionId: number) {
  const rows = await prisma.ledgerEntry.findMany({
    where: { financialTransactionId },
    include: { account: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => ({
    code: row.account.code,
    direction: row.direction,
    amount: new Decimal(row.amount).toString(),
    currency: row.currency,
  }));
}

/** The posting written for one execution, or a readable failure. */
async function postingFor(refundExecutionId: number) {
  const key = `refund_execution:${refundExecutionId}`;
  const posting = await prisma.financialTransaction.findUnique({ where: { idempotencyKey: key } });
  expect(posting, `no ledger posting found under idempotency key "${key}"`).not.toBeNull();
  return posting!;
}

/** The buyer's current IDR balance, as a comparable string. */
async function idrBalance(userId: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return new Decimal(user.walletBalance).toString();
}

// ── 1. WALLET payout ───────────────────────────────────────────────────────

describe("executeRefund — WALLET", () => {
  it("credits the buyer's wallet, records a COMPLETED execution, and completes the Refund", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");
    expect(await idrBalance(sample.user.id)).toBe("0");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
      notes: "Dead account replaced with credit.",
    });

    // The money actually moved.
    expect(await idrBalance(sample.user.id)).toBe("2");

    // The execution row describes that payout.
    expect(execution.refundId).toBe(refund.id);
    expect(execution.method).toBe(RefundExecutionMethod.WALLET);
    expect(new Decimal(execution.amount).toString()).toBe("2");
    expect(execution.currency).toBe("IDR");
    expect(execution.status).toBe(RefundExecutionStatus.COMPLETED);
    expect(execution.executedBy).toBe(ADMIN_ID);
    expect(execution.executedAt).not.toBeNull();
    expect(execution.notes).toBe("Dead account replaced with credit.");
    expect(execution.proofFileId).toBeNull();

    // The parent Refund is settled.
    const settled = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(settled.status).toBe(RefundStatus.COMPLETED);
    expect(settled.processedAt).not.toBeNull();
  });

  it("writes one refund_execution WalletTransaction with NO orderId, and points the execution's reference at it", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    const movements = await prisma.walletTransaction.findMany({
      where: { reason: "refund_execution" },
    });
    expect(movements).toHaveLength(1);
    const movement = movements[0]!;
    expect(new Decimal(movement.delta).toString()).toBe("2");
    expect(movement.currency).toBe("IDR");
    expect(movement.adminId).toBe(ADMIN_ID);
    // The whole point of the design: no orderId, so the (orderId, reason)
    // UNIQUE index cannot collide on a second refund for this order.
    expect(movement.orderId).toBeNull();
    // Traceability lives here instead.
    expect(execution.reference).toBe(String(movement.id));
  });

  it("keeps a caller-supplied reference instead of overwriting it with the wallet transaction id", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      reference: "TICKET-4821",
      executedBy: ADMIN_ID,
    });

    expect(execution.reference).toBe("TICKET-4821");
  });

  it("ignores proofFileId on a WALLET execution instead of rejecting it", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      proofFileId: "AgACAgQAAx-not-used-here",
      executedBy: ADMIN_ID,
    });

    expect(execution.proofFileId).toBeNull();
  });

  it("posts Dr sales_revenue / Cr wallet_liability for an order whose revenue was recognised", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    const posting = await postingFor(execution.id);
    expect(posting.type).toBe(FinancialTransactionType.REFUND);
    expect(posting.referenceType).toBe("refund_execution");
    expect(posting.referenceId).toBe(execution.id);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "sales_revenue.idr", direction: "DEBIT", amount: "2", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "2", currency: "IDR" },
    ]);
  });

  it("posts Dr provider_clearing instead when the order never had its payment recognised", async () => {
    const order = await makeUnsettledOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    const posting = await postingFor(execution.id);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: "2", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "2", currency: "IDR" },
    ]);
  });
});

// ── 2. The (orderId, reason) collision this design exists to avoid ─────────

describe("executeRefund — two WALLET executions against the same order", () => {
  it("both succeed and both credit the buyer (the (orderId, reason) UNIQUE constraint must not be reachable)", async () => {
    const order = await makeDeliveredOrder();
    const first = await makeProcessingRefund(order.id, "1.00");
    const second = await makeProcessingRefund(order.id, "2.00");

    const firstExecution = await executeRefund(prisma, {
      refundId: first.id,
      method: RefundExecutionMethod.WALLET,
      amount: "1.00",
      executedBy: ADMIN_ID,
    });
    // A second bad unit turns up later. Without `orderId: null` this throws a
    // unique violation and a customer who is owed money does not get paid.
    const secondExecution = await executeRefund(prisma, {
      refundId: second.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    expect(await idrBalance(sample.user.id)).toBe("3");

    const movements = await prisma.walletTransaction.findMany({
      where: { reason: "refund_execution" },
      orderBy: { id: "asc" },
    });
    expect(movements).toHaveLength(2);
    expect(movements.map((m) => new Decimal(m.delta).toString())).toEqual(["1", "2"]);

    // Two distinct executions, two distinct postings — the idempotency key is
    // per execution, so neither is mistaken for a replay of the other.
    expect(secondExecution.id).not.toBe(firstExecution.id);
    const postings = await Promise.all([postingFor(firstExecution.id), postingFor(secondExecution.id)]);
    expect(postings[0]!.id).not.toBe(postings[1]!.id);
    expect(new Set(postings.map((p) => p.idempotencyKey)).size).toBe(2);
  });

  it("also allows two executions against the SAME Refund (a retried payout)", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "3.00");

    const first = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "1.00",
      executedBy: ADMIN_ID,
    });
    // The first execution completed the Refund, so a second attempt on the same
    // Refund has to reopen it the way a real retry would — PROCESSING again.
    await prisma.refund.update({
      where: { id: refund.id },
      data: { status: RefundStatus.PROCESSING, processedAt: null },
    });
    const second = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    expect(await idrBalance(sample.user.id)).toBe("3");
    const executions = await prisma.refundExecution.findMany({
      where: { refundId: refund.id },
      orderBy: { id: "asc" },
    });
    expect(executions.map((e) => e.id)).toEqual([first.id, second.id]);
  });
});

// ── 3. MANUAL_TRANSFER payout ──────────────────────────────────────────────

describe("executeRefund — MANUAL_TRANSFER", () => {
  it("moves no wallet money, stores the proof file id, and credits cash rather than wallet_liability", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.MANUAL_TRANSFER,
      amount: "2.00",
      reference: "BCA-93810",
      proofFileId: "AgACAgQAAxkBAAIT",
      executedBy: ADMIN_ID,
    });

    // No wallet involvement at all.
    expect(await idrBalance(sample.user.id)).toBe("0");
    expect(await prisma.walletTransaction.count({ where: { reason: "refund_execution" } })).toBe(0);

    expect(execution.status).toBe(RefundExecutionStatus.COMPLETED);
    expect(execution.proofFileId).toBe("AgACAgQAAxkBAAIT");
    expect(execution.reference).toBe("BCA-93810");

    const posting = await postingFor(execution.id);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "sales_revenue.idr", direction: "DEBIT", amount: "2", currency: "IDR" },
      { code: "cash.idr", direction: "CREDIT", amount: "2", currency: "IDR" },
    ]);

    const settled = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(settled.status).toBe(RefundStatus.COMPLETED);
  });

  it("leaves reference null when the caller supplied none (there is no wallet transaction to fall back on)", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.MANUAL_TRANSFER,
      amount: "2.00",
      proofFileId: "AgACAgQAAxkBAAIT",
      executedBy: ADMIN_ID,
    });

    expect(execution.reference).toBeNull();
  });

  it("rejects a MANUAL_TRANSFER with no proof of the transfer", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
        amount: "2.00",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);

    // Nothing at all was persisted by the rejected attempt.
    expect(await prisma.refundExecution.count()).toBe(0);
    const untouched = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(untouched.status).toBe(RefundStatus.PROCESSING);
  });

  it("rejects a blank proofFileId the same way as a missing one", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
        amount: "2.00",
        proofFileId: "   ",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ── 4. The order-level refundable budget ───────────────────────────────────

describe("executeRefund — refundable amount", () => {
  it("rejects an amount that would take the order's total refunded past its totalAmount", async () => {
    const order = await makeDeliveredOrder();
    const total = new Decimal(order.totalAmount);

    const first = await makeProcessingRefund(order.id, total.toString());
    await executeRefund(prisma, {
      refundId: first.id,
      method: RefundExecutionMethod.WALLET,
      amount: total.minus(1).toString(),
      executedBy: ADMIN_ID,
    });

    // Only 1.00 of the order's value is left to refund; ask for 2.00.
    const second = await makeProcessingRefund(order.id, "2.00");
    await expect(
      executeRefund(prisma, {
        refundId: second.id,
        method: RefundExecutionMethod.WALLET,
        amount: "2.00",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);

    // The rejected attempt paid nothing and left no execution row behind.
    expect(await idrBalance(sample.user.id)).toBe(total.minus(1).toString());
    expect(await prisma.refundExecution.count()).toBe(1);
  });

  it("allows an amount that exactly exhausts the remaining refundable total (boundary, not strictly-less)", async () => {
    const order = await makeDeliveredOrder();
    const total = new Decimal(order.totalAmount);

    const first = await makeProcessingRefund(order.id, "1.00");
    await executeRefund(prisma, {
      refundId: first.id,
      method: RefundExecutionMethod.WALLET,
      amount: "1.00",
      executedBy: ADMIN_ID,
    });

    const second = await makeProcessingRefund(order.id, total.minus(1).toString());
    const execution = await executeRefund(prisma, {
      refundId: second.id,
      method: RefundExecutionMethod.WALLET,
      amount: total.minus(1).toString(),
      executedBy: ADMIN_ID,
    });

    expect(execution.status).toBe(RefundExecutionStatus.COMPLETED);
    expect(await idrBalance(sample.user.id)).toBe(total.toString());
  });

  it("does not count a FAILED execution against the refundable total", async () => {
    const order = await makeDeliveredOrder();
    const total = new Decimal(order.totalAmount);
    const refund = await makeProcessingRefund(order.id, total.toString());

    // A bank transfer that bounced, recorded by hand the way a follow-on
    // function would: it paid nothing, so it must not burn refund budget.
    await prisma.refundExecution.create({
      data: {
        refundId: refund.id,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
        amount: total,
        currency: "IDR",
        status: RefundExecutionStatus.FAILED,
        executedBy: ADMIN_ID,
        executedAt: new Date(),
      },
    });

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: total.toString(),
      executedBy: ADMIN_ID,
    });

    expect(execution.status).toBe(RefundExecutionStatus.COMPLETED);
    expect(await idrBalance(sample.user.id)).toBe(total.toString());
  });
});

// ── 5. Order.status ────────────────────────────────────────────────────────

describe("executeRefund — Order.status", () => {
  it("moves a DELIVERED order to REFUNDED once the refunds add up to its whole total", async () => {
    const order = await makeDeliveredOrder();
    const total = new Decimal(order.totalAmount);
    const refund = await makeProcessingRefund(order.id, total.toString());

    await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: total.toString(),
      executedBy: ADMIN_ID,
    });

    const after = (await getOrder(prisma, order.id))!;
    expect(after.status).toBe(OrderStatus.REFUNDED);
    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId: order.id, status: OrderStatus.REFUNDED },
    });
    expect(history).toHaveLength(1);
  });

  it("reaches REFUNDED only on the execution that completes the total, not on the partial before it", async () => {
    const order = await makeDeliveredOrder();
    const total = new Decimal(order.totalAmount);

    const first = await makeProcessingRefund(order.id, "1.00");
    await executeRefund(prisma, {
      refundId: first.id,
      method: RefundExecutionMethod.WALLET,
      amount: "1.00",
      executedBy: ADMIN_ID,
    });
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.DELIVERED);

    const second = await makeProcessingRefund(order.id, total.minus(1).toString());
    await executeRefund(prisma, {
      refundId: second.id,
      method: RefundExecutionMethod.WALLET,
      amount: total.minus(1).toString(),
      executedBy: ADMIN_ID,
    });
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.REFUNDED);
  });

  it("leaves a partial refund's order DELIVERED", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.DELIVERED);
  });

  it("skips the transition, without throwing, for a full refund of an order that is not DELIVERED", async () => {
    const order = await makeUnsettledOrder();
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    const total = new Decimal(order.totalAmount);
    const refund = await makeProcessingRefund(order.id, total.toString());

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: total.toString(),
      executedBy: ADMIN_ID,
    });

    expect(execution.status).toBe(RefundExecutionStatus.COMPLETED);
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });
});

// ── 6. Preconditions ───────────────────────────────────────────────────────

describe("executeRefund — preconditions", () => {
  it("rejects a Refund still in PENDING (this function does not review a refund, it pays one)", async () => {
    const order = await makeDeliveredOrder();
    const refund = await createRefund(prisma, {
      orderId: order.id,
      amount: "2.00",
      currency: "IDR",
      adminId: ADMIN_ID,
    });

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.WALLET,
        amount: "2.00",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);
    expect(await idrBalance(sample.user.id)).toBe("0");
  });

  it("rejects a Refund that already reached COMPLETED", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");
    await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "1.00",
      executedBy: ADMIN_ID,
    });

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.WALLET,
        amount: "1.00",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);
    expect(await idrBalance(sample.user.id)).toBe("1");
  });

  it("rejects a non-existent Refund", async () => {
    await expect(
      executeRefund(prisma, {
        refundId: 999_999_999,
        method: RefundExecutionMethod.WALLET,
        amount: "2.00",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects an unknown payout method", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    await expect(
      executeRefund(prisma, {
        refundId: refund.id,
        method: "CARRIER_PIGEON",
        amount: "2.00",
        executedBy: ADMIN_ID,
      }),
    ).rejects.toThrow(ValidationError);
    expect(await prisma.refundExecution.count()).toBe(0);
  });

  it.each([["0"], ["-2.00"], ["not-a-number"]])(
    "rejects the invalid amount %s as a clean ValidationError",
    async (amount) => {
      const order = await makeDeliveredOrder();
      const refund = await makeProcessingRefund(order.id, "2.00");

      await expect(
        executeRefund(prisma, {
          refundId: refund.id,
          method: RefundExecutionMethod.WALLET,
          amount,
          executedBy: ADMIN_ID,
        }),
      ).rejects.toThrow(ValidationError);
      expect(await prisma.refundExecution.count()).toBe(0);
    },
  );
});

// ── 7. Audit trail ─────────────────────────────────────────────────────────

describe("executeRefund — audit trail", () => {
  it("audits the payout against the acting admin, and never writes the proof file id anywhere readable", async () => {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");

    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.MANUAL_TRANSFER,
      amount: "2.00",
      proofFileId: "AgACAgQAAxkBAAIT-secret-file-id",
      executedBy: ADMIN_ID,
    });

    const audits = await prisma.auditLog.findMany({
      where: { action: "refund_executed", targetId: execution.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.adminId).toBe(ADMIN_ID);
    expect(audits[0]!.targetType).toBe("refund_execution");
    expect(audits[0]!.details).toContain(order.orderCode);
    expect(audits[0]!.details).toContain("2");

    // The payment-proof file_id is on this repo's "never log secrets" list, so
    // it must appear in no audit row and no ledger description.
    const everyAudit = await prisma.auditLog.findMany();
    for (const row of everyAudit) {
      expect(row.details ?? "").not.toContain("AgACAgQAAxkBAAIT");
    }
    const posting = await postingFor(execution.id);
    expect(posting.description).not.toContain("AgACAgQAAxkBAAIT");
  });
});

// ── 8. Admin-UI vocabulary ─────────────────────────────────────────────────

describe("wallet reason vocabulary", () => {
  it("lists refund_execution, so the admin wallet ledger can filter these payouts", () => {
    expect(WALLET_TX_REASONS).toContain("refund_execution");
  });
});
