/**
 * `executeRefund` (Financial Ledger M4) — the first general-purpose refund
 * PAYOUT path in this shop. Everything the Refund domain could do before this
 * was record-keeping: `transitionRefundStatus` reaching COMPLETED explicitly
 * moves no money (it demands `acknowledgeNoPayout`), and the one real payout
 * that existed, `refundUnderpaidOrder`, is a narrow crypto-shortfall mechanism
 * that writes its own Refund row and never touches the state machine.
 *
 * So these tests are the only thing standing between a buyer who is owed money
 * and a payout that silently does not happen. Five properties get asserted
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
 * 5. **The refundable ceiling holds under a real race.** The budget check is a
 *    read-then-write, so it is only as good as the order-row lock taken before
 *    it; section 9 races two payouts on one order from two separate
 *    PrismaClients to prove that lock, because nothing that runs one `await` at
 *    a time can.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  FinancialTransactionType,
  OrderStatus,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
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
   channel: "bot",
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
  // Legacy drafts may predate the creation cap; keep testing the payout backstop.
  const refund = await prisma.refund.create({ data: { orderId, amount: new Decimal(amount), currency } });
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

/**
 * Everything pino writes while `fn` runs, as one string.
 *
 * Hooks the transport rather than spying on `logger.info`/`logger.warn`
 * individually — the same idiom, and the same reasoning, as
 * `payment_log_secrets.test.ts`: a spy per method only sees the methods it was
 * told about, so a leak added through `logger.debug` or a child logger would
 * walk straight past it. Everything goes through this one stream.
 *
 * Captures the structured metadata as well as the message sentence, because a
 * secret in the metadata object is just as leaked as one interpolated into the
 * prose.
 */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const stream = logger as unknown as { [k: symbol]: unknown };
  const streamSym = Object.getOwnPropertySymbols(stream).find((s) => s.toString().includes("stream"));
  const original = streamSym ? stream[streamSym] : undefined;
  const sink = {
    write: (chunk: string) => {
      captured += chunk;
    },
  };
  if (streamSym) (stream as Record<symbol, unknown>)[streamSym] = sink;
  const originalLevel = logger.level;
  // Exercise every log level even when the test runner suppresses routine logs.
  logger.level = "trace";
  try {
    await fn();
  } finally {
    logger.level = originalLevel;
    if (streamSym) (stream as Record<symbol, unknown>)[streamSym] = original;
  }
  return captured;
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

    // And the status-change audit row an admin reads beside this payout says the
    // buyer WAS paid. `transitionRefundStatus` appends "record-keeping only — no
    // payout was triggered" for a refund closed without one; printing that here,
    // beside a wallet credit the buyer has already received, told the shop admin
    // the opposite of the truth.
    const statusRows = await prisma.auditLog.findMany({
      where: { action: "refund_status_change", targetId: refund.id },
    });
    const completedRow = statusRows.find((r) => (r.details ?? "").includes("COMPLETED"))!;
    expect(completedRow.details).toContain("The buyer has been paid");
    expect(completedRow.details).toContain(`refund execution #${execution.id}`);
    expect(completedRow.details).not.toContain("no payout was triggered");
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

  // "0.00001" is not redundant with "0": `parseRefundAmount` accepts it (it is
  // finite and greater than zero), and only the re-check AFTER
  // `quantizeMoney(…, 4)` catches it. Without that second check this amount
  // would record a COMPLETED payout of 0.0000 — a written claim that a buyer
  // was paid, next to a wallet balance that never moved.
  it.each([["0"], ["-2.00"], ["not-a-number"], ["0.00001"]])(
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

    // Captured, not just called: M9 added developer log lines to this path (the
    // ledger posting, and the payout line itself), and the pino stream is the
    // one place the proof file id could reach that the audit/ledger assertions
    // below would never see.
    let execution!: Awaited<ReturnType<typeof executeRefund>>;
    const logged = await captureLogs(async () => {
      execution = await executeRefund(prisma, {
        refundId: refund.id,
        method: RefundExecutionMethod.MANUAL_TRANSFER,
        amount: "2.00",
        proofFileId: "AgACAgQAAxkBAAIT-secret-file-id",
        executedBy: ADMIN_ID,
      });
    });

    // Asserted first, so the "no secret" checks below can never pass vacuously
    // by capturing nothing at all.
    expect(logged).toContain(order.orderCode);
    expect(logged).not.toContain("AgACAgQAAxkBAAIT");

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

// ── 9. True Postgres concurrency: the order-row lock ───────────────────────
//
// Section 4's budget tests call `executeRefund` one `await` at a time, so they
// prove the arithmetic of the refundable ceiling but say nothing about the
// `SELECT id FROM orders WHERE id = … FOR UPDATE` that guards it
// (`refunds.ts`): delete that line and every test above still passes. The
// budget check is a read-then-write — sum what has already been paid out, then
// add to it — so two admins approving two different Refunds on ONE order at the
// same instant would otherwise both read the same "already paid out" total,
// both pass their own check, and both commit, refunding more than the order was
// ever worth.
//
// `Promise.allSettled` against the real dev Postgres is the idiom
// checkout_intent_concurrency.test.ts and stock_concurrency.test.ts use, and it
// is kept here — but it is NOT enough on its own, which is worth stating
// because it is not obvious: two interactive transactions opened from ONE
// PrismaClient do not overlap in this setup. Measured while building this test,
// the second transaction's BEGIN did not run until ~2.0s after the first one
// COMMITted, so the "loser" only ever read the budget after the winner had
// already finished — which is why an earlier version of this test still passed
// with the `FOR UPDATE` line commented out. (That also explains the P2028
// "unable to start a transaction in the given time" flake
// checkout_intent_concurrency.test.ts documents on Prisma's 2s default
// maxWait: the second transaction really was waiting that long to start.)
//
// So the two racers get a PrismaClient each, pointed at this test's own schema.
// Separate clients mean separate connection pools, and two transactions that are
// genuinely open at the same instant: verified by measurement (both read before
// either committed) and by mutation (commenting out the `FOR UPDATE` line makes
// this test fail with two payouts, as it must).
describe("executeRefund under true Postgres concurrency — the order-row lock", () => {
  /**
   * A second PrismaClient on the same schema as `prisma`, so its transactions
   * really can interleave with the first client's. `current_schema()` is read
   * back from the live connection rather than recomputed, because the schema
   * name is `makeTestDb`'s private random per-file value.
   */
  async function connectRivalClient(): Promise<PrismaClient> {
    const baseUrl = process.env.DATABASE_URL_PRISMA;
    if (!baseUrl) throw new Error("DATABASE_URL_PRISMA must be set to a Postgres connection string for tests.");
    const rows = await prisma.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`;
    const url = new URL(baseUrl);
    url.searchParams.set("schema", rows[0]!.schema);
    const rival = new PrismaClient({ datasourceUrl: url.toString() });
    // Connect before the race: otherwise the first thing the rival's
    // transaction waits for is a TCP handshake, not the row lock under test.
    await prisma.$queryRaw`SELECT 1`;
    await rival.$queryRaw`SELECT 1`;
    return rival;
  }

  it("two admins pay out two PROCESSING refunds on one order at the same instant: exactly one payout lands", async () => {
    const order = await makeDeliveredOrder();
    const total = new Decimal(order.totalAmount);
    // Each attempt is legitimate on its own (it fits inside the untouched
    // refundable total) but the two together exceed it, so exactly one of them
    // must lose. Asserted rather than assumed: if the sample order's total ever
    // changed such that both payouts fit, this test would still pass while
    // proving nothing.
    const payout = total.minus(1);
    expect(
      payout.times(2).greaterThan(total),
      "both payouts together must exceed the order's refundable total, or there is no race to lose",
    ).toBe(true);

    const firstRefund = await makeProcessingRefund(order.id, payout.toString());
    const secondRefund = await makeProcessingRefund(order.id, payout.toString());
    const rival = await connectRivalClient();

    try {
      // maxWait/timeout are raised well above Prisma's 2s/5s defaults ON
      // PURPOSE, the same way checkout_intent_concurrency.test.ts raises them on
      // its wallet-credit double-tap: the loser blocks on the winner's row lock
      // for as long as the winner's whole transaction takes (wallet credit,
      // execution row, ledger posting, two status transitions, audit line), and
      // that wait counts against the loser's own transaction budget. On the
      // defaults, a loaded parallel run can make the loser give up with a
      // timeout BEFORE it ever reaches the budget check — still safe (nothing is
      // paid either way) but a different code path, which is exactly the kind of
      // flake that makes a money-critical test worthless.
      const payOut = (client: PrismaClient, refundId: number) =>
        client.$transaction(
          (tx) =>
            executeRefund(tx, {
              refundId,
              method: RefundExecutionMethod.WALLET,
              amount: payout.toString(),
              executedBy: ADMIN_ID,
            }),
          { maxWait: 30_000, timeout: 60_000 },
        );

      const results = await Promise.allSettled([
        payOut(prisma, firstRefund.id),
        payOut(rival, secondRefund.id),
      ]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof executeRefund>>> => r.status === "fulfilled",
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      // The loser must be refused by the budget check itself, with the clean
      // ValidationError an admin UI can render — not by a raw Postgres lock
      // timeout or deadlock leaking out as an unhandled 500.
      expect(rejected[0]!.reason).toBeInstanceOf(ValidationError);
      expect((rejected[0]!.reason as ValidationError).key).toBe("error.refund_exceeds_refundable_amount");

      // Exactly one payout, and it is a real one — not a "both attempts failed"
      // false pass.
      const winner = fulfilled[0]!.value;
      expect(winner.status).toBe(RefundExecutionStatus.COMPLETED);
      expect(await prisma.refundExecution.count()).toBe(1);
      expect(await prisma.refundExecution.count({ where: { status: RefundExecutionStatus.COMPLETED } })).toBe(1);

      // The buyer was credited once, for exactly one payout — not twice, and
      // not some half-applied amount.
      expect(await idrBalance(sample.user.id)).toBe(payout.toString());
      expect(await prisma.walletTransaction.count({ where: { reason: "refund_execution" } })).toBe(1);

      // The books agree: one refund posting, with no orphan left behind by the
      // loser's rolled-back attempt.
      expect(await prisma.financialTransaction.count({ where: { referenceType: "refund_execution" } })).toBe(1);

      // The loser's Refund is untouched and still payable — its money was never
      // sent, so an admin can still act on it (lower the amount, or cancel it).
      const loserRefundId = winner.refundId === firstRefund.id ? secondRefund.id : firstRefund.id;
      const loser = await prisma.refund.findUniqueOrThrow({ where: { id: loserRefundId } });
      expect(loser.status).toBe(RefundStatus.PROCESSING);
      expect(loser.processedAt).toBeNull();
      const won = await prisma.refund.findUniqueOrThrow({ where: { id: winner.refundId } });
      expect(won.status).toBe(RefundStatus.COMPLETED);

      // A partial refund leaves the order where it was.
      expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.DELIVERED);
    } finally {
      await rival.$disconnect();
    }
    // An explicit budget rather than the config's shared 20s testTimeout: this
    // test costs ~5.3s on an idle machine, and only ~0.2s of that is the race
    // itself — ~2.1s is the second PrismaClient spinning up its own query engine
    // and pool, the rest is the DELIVERED-order fixture. That makes it the
    // slowest test in the suite, i.e. the first one a loaded parallel run would
    // push past 20s, and a money-critical lock test must fail because the lock
    // failed, never because the machine was busy.
  }, 40_000);
});
