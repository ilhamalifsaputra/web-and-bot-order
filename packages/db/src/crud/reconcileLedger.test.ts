/**
 * Ledger reconciliation (Financial Ledger M5) — `reconcileLedger`, the
 * read-only drift detector that cross-checks the shop's operational rows
 * (Order / Payment / User wallet balances / RefundExecution) against the
 * `FinancialTransaction`/`LedgerEntry` rows M3 and M4 write for them.
 *
 * What makes this file worth its runtime is that every check here is a
 * NEGATIVE-by-default one: on healthy books all four return nothing, so a check
 * that is silently broken looks exactly like a check that is silently passing.
 * Each check therefore gets both branches — a healthy fixture asserted to
 * produce NO finding, and a deliberately damaged one asserted to produce
 * exactly the right finding — because either half alone would pass against a
 * function that always returned `[]` (or always returned everything).
 *
 * Two checks defend invariants the database itself enforces, so their damaged
 * fixture has to be built the way the real failure would arrive — around the
 * Prisma client, by a manual edit or a migration inconsistency:
 * `DUPLICATE_PROVIDER_TRANSACTION` drops the unique index for the length of one
 * test, and `REFUND_AMOUNT_MISMATCH` rewrites a `RefundExecution.amount` after
 * its posting was made. Neither state is reachable through the app's own API,
 * which is the point of checking for it.
 *
 * The cutover boundary gets its own three cases (before / after / no ledger at
 * all), because it is the one piece of logic here that decides what NOT to
 * report, and getting it wrong in the permissive direction floods the first
 * production run with every pre-ledger order the backfill (M10) has not reached
 * yet.
 *
 * `WALLET_LEDGER_DRIFT` additionally gets the four states one order's wallet
 * hold passes through — spent at checkout, released, settled, and spent while a
 * genuine hand-edit also drifted — because the buyers' balances and the control
 * account are moved at DIFFERENT moments (checkout vs settlement) and a check
 * that ignores the gap between them fires on every ordinary wallet checkout. Each
 * of those fixtures walks the real path (`createOrderDirect` →
 * `attachPaymentProof` → `approveOrder`/`rejectOrder`) rather than writing
 * movement rows by hand, since the timing is the thing under test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  FinancialTransactionType,
  LedgerDirection,
  OrderStatus,
  PaymentMethod,
  ReconciliationFindingType,
  ReconciliationSeverity,
  RefundExecutionMethod,
  RefundStatus,
} from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  approveOrder,
  attachPaymentProof,
  createOrderDirect,
  createRefund,
  createWalletTopupOrder,
  executeRefund,
  getOrder,
  postFinancialTransaction,
  reconcileLedger,
  rejectOrder,
  settleWalletTopup,
  transitionRefundStatus,
  type LedgerReconciliationFinding,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

/** The acting admin for every audited call below — a real User row, because
 *  `audit_logs.admin_id` is a foreign key. */
let ADMIN_ID: number;

/**
 * The fixed instant every test anchors its ledger at. `reconcileLedger`'s
 * cutover boundary is the EARLIEST `FinancialTransaction.occurredAt` in the
 * table, so anchoring it explicitly is what lets a test place an order
 * unambiguously before or after it instead of racing the wall clock.
 */
const ANCHOR_AT = new Date("2026-09-01T00:00:00.000Z");
const AFTER_ANCHOR = new Date("2026-09-02T00:00:00.000Z");
const BEFORE_ANCHOR = new Date("2026-08-01T00:00:00.000Z");

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
      telegramId: 9_000_000_002,
      username: "ledger-recon-admin",
      fullName: "Ledger Reconciliation Admin",
      role: "ADMIN",
      referralCode: `lr${Math.random()}`,
    },
  });
  ADMIN_ID = admin.id;
});

// ── Fixture builders ───────────────────────────────────────────────────────

/**
 * Put one unrelated posting in the books at `ANCHOR_AT`, so the cutover
 * boundary is a known instant rather than "whenever this test happened to run".
 * Deliberately an ADJUSTMENT between two accounts no check under test reads
 * (`cash.idr` / `adjustment.idr`), so anchoring never perturbs an assertion.
 */
async function anchorLedger(occurredAt = ANCHOR_AT) {
  return postFinancialTransaction(prisma, {
    type: FinancialTransactionType.ADJUSTMENT,
    referenceType: "manual",
    referenceId: 0,
    idempotencyKey: `test-anchor:${occurredAt.toISOString()}`,
    description: "Anchoring the books for a reconciliation test.",
    occurredAt,
    entries: [
      { accountCode: "cash.idr", direction: LedgerDirection.DEBIT, amount: "1.00", currency: "IDR" },
      { accountCode: "adjustment.idr", direction: LedgerDirection.CREDIT, amount: "1.00", currency: "IDR" },
    ],
  });
}

/** A DELIVERED product order, settled through the path a real buyer walks, so
 *  its `order:{id}:payment` posting is a real one. */
async function makeDeliveredOrder() {
  const created = await createOrderDirect(prisma, {
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  await approveOrder(prisma, created!.id, { adminId: ADMIN_ID });
  const delivered = (await getOrder(prisma, created!.id))!;
  expect(delivered.status).toBe(OrderStatus.DELIVERED);
  return delivered;
}

/**
 * Erase one posting and its entries, leaving the money movement that produced
 * it in place — "real money moved, the books never recorded it", which is the
 * exact state `LEDGER_POSTING_MISSING` exists to find. Deleted directly rather
 * than through any helper: the ledger is append-only by design and has no
 * delete path, which is why this can only be a test fixture.
 */
async function erasePosting(idempotencyKey: string) {
  const posting = await prisma.financialTransaction.findUnique({ where: { idempotencyKey } });
  expect(posting, `no posting to erase under idempotency key "${idempotencyKey}"`).not.toBeNull();
  await prisma.ledgerEntry.deleteMany({ where: { financialTransactionId: posting!.id } });
  await prisma.financialTransaction.delete({ where: { id: posting!.id } });
}

/** Move an order's payment instant, which is what the cutover boundary reads. */
async function setPaidAt(orderId: number, paidAt: Date) {
  await prisma.order.update({ where: { id: orderId }, data: { paidAt } });
}

/**
 * Fund the sample buyer's IDR wallet the way a real top-up does — one
 * settlement moving BOTH the balance and `wallet_liability.idr` — so a fixture
 * that then spends that credit starts from books which already agree. Returns
 * the refreshed user row, because `createOrderDirect` reads the balance off the
 * object it is handed rather than re-reading it.
 */
async function fundWallet(amount: string) {
  const topup = await createWalletTopupOrder(prisma, {
    userId: sample.user.id,
    amount,
    currency: "IDR",
    method: PaymentMethod.TOKOPAY,
  });
  await settleWalletTopup(prisma, topup.id, { amount });
  return prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
}

/**
 * An order sitting in PENDING_VERIFICATION that spent wallet credit at
 * checkout, built through the real checkout path (`createOrderDirect` →
 * `attachPaymentProof`) rather than hand-written rows: the whole point of these
 * cases is that the ordinary checkout debits `User.walletBalance` immediately
 * while the ledger posts nothing until settlement, and a hand-written fixture
 * could quietly get that timing wrong.
 */
async function makeInFlightWalletSpendOrder(walletAmount: string) {
  // Funded well above what the order spends, so the balance left over is
  // non-zero and a term that wrongly cancelled the whole balance would show up.
  const user = await fundWallet("20.00");
  const created = await createOrderDirect(prisma, {
    user,
    productId: sample.product.id,
    quantity: 1,
    walletAmount,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  const order = (await getOrder(prisma, created!.id))!;
  expect(order.status).toBe(OrderStatus.PENDING_VERIFICATION);
  expect(new Decimal(order.walletUsed).toString()).toBe(new Decimal(walletAmount).toString());
  return order;
}

/** A Refund sitting in PROCESSING — the only state `executeRefund` accepts. */
async function makeProcessingRefund(orderId: number, amount: Decimal.Value) {
  const refund = await createRefund(prisma, { orderId, amount, currency: "IDR", adminId: ADMIN_ID });
  await transitionRefundStatus(prisma, {
    refundId: refund.id,
    from: RefundStatus.PENDING,
    to: RefundStatus.PROCESSING,
    adminId: ADMIN_ID,
  });
  return refund;
}

// ── Assertion helpers ──────────────────────────────────────────────────────

const ofType = (findings: LedgerReconciliationFinding[], type: string) =>
  findings.filter((finding) => finding.type === type);

const missing = (findings: LedgerReconciliationFinding[]) =>
  ofType(findings, ReconciliationFindingType.LEDGER_POSTING_MISSING);

// ── 1. LEDGER_POSTING_MISSING — orders ─────────────────────────────────────

describe("reconcileLedger — LEDGER_POSTING_MISSING (orders)", () => {
  it("reports nothing for a DELIVERED order whose ORDER_PAYMENT was posted", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    await setPaidAt(order.id, AFTER_ANCHOR);

    const findings = await reconcileLedger(prisma);

    expect(missing(findings)).toEqual([]);
  });

  it("reports the one DELIVERED order that has no ORDER_PAYMENT posting", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    await erasePosting(`order:${order.id}:payment`);
    await setPaidAt(order.id, AFTER_ANCHOR);

    const findings = await reconcileLedger(prisma);

    const found = missing(findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      type: ReconciliationFindingType.LEDGER_POSTING_MISSING,
      entity: "order",
      entityId: String(order.id),
      expected: "posted",
      actual: "missing",
      difference: null,
      currency: order.currency,
      severity: ReconciliationSeverity.CRITICAL,
    });
    // The reference has to be something an admin can act on without opening a
    // database client: the order code and the key that should have existed.
    expect(found[0]!.reference).toContain(order.orderCode);
    expect(found[0]!.reference).toContain(`order:${order.id}:payment`);
    expect(found[0]!.detectedAt).toBeInstanceOf(Date);
  });

  it("reports nothing for an unposted order that predates the cutover boundary", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    await erasePosting(`order:${order.id}:payment`);
    // Paid a month before the ledger recorded anything at all: this order
    // PREDATES the ledger rather than drifting from it, and M10's backfill —
    // not a 6-hourly drift alert — is what will book it.
    await setPaidAt(order.id, BEFORE_ANCHOR);

    const findings = await reconcileLedger(prisma);

    expect(missing(findings)).toEqual([]);
  });

  it("reports nothing at all when the ledger has never posted anything", async () => {
    const order = await makeDeliveredOrder();
    await erasePosting(`order:${order.id}:payment`);

    // No FinancialTransaction anywhere → no cutover boundary can be derived, so
    // the missing-posting check does not run. A fresh or test database must not
    // read as "every order in the shop is missing its posting".
    expect(await prisma.financialTransaction.count()).toBe(0);

    const findings = await reconcileLedger(prisma);

    expect(missing(findings)).toEqual([]);
  });

  it("reports a settled WALLET_TOPUP order against its own topup key", async () => {
    await anchorLedger();
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "20000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    await settleWalletTopup(prisma, topup.id, { amount: "20000" });
    await erasePosting(`order:${topup.id}:topup`);
    await setPaidAt(topup.id, AFTER_ANCHOR);

    const findings = await reconcileLedger(prisma);

    const found = missing(findings);
    expect(found).toHaveLength(1);
    expect(found[0]!.entityId).toBe(String(topup.id));
    // A top-up is keyed `order:{id}:topup`, never `:payment` — checking for the
    // wrong key would report every settled top-up in the shop as missing.
    expect(found[0]!.reference).toContain(`order:${topup.id}:topup`);
  });

  it("reports nothing for a settled WALLET_TOPUP whose posting is intact", async () => {
    await anchorLedger();
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "20000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    await settleWalletTopup(prisma, topup.id, { amount: "20000" });
    await setPaidAt(topup.id, AFTER_ANCHOR);

    const findings = await reconcileLedger(prisma);

    expect(missing(findings)).toEqual([]);
  });
});

// ── 2. LEDGER_POSTING_MISSING — refund executions ──────────────────────────

describe("reconcileLedger — LEDGER_POSTING_MISSING (refund executions)", () => {
  it("reports a COMPLETED payout with no REFUND posting", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");
    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });
    await erasePosting(`refund_execution:${execution.id}`);
    await prisma.refundExecution.update({
      where: { id: execution.id },
      data: { executedAt: AFTER_ANCHOR },
    });

    const findings = await reconcileLedger(prisma);

    const found = missing(findings).filter((f) => f.entity === "refund_execution");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      entity: "refund_execution",
      entityId: String(execution.id),
      expected: "posted",
      actual: "missing",
      difference: null,
      currency: "IDR",
      severity: ReconciliationSeverity.CRITICAL,
    });
    expect(found[0]!.reference).toContain(`refund_execution:${execution.id}`);
  });

  it("reports nothing for an ordinary executeRefund payout", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, "2.00");
    await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    const findings = await reconcileLedger(prisma);

    expect(missing(findings).filter((f) => f.entity === "refund_execution")).toEqual([]);
  });
});

// ── 3. WALLET_LEDGER_DRIFT ─────────────────────────────────────────────────

describe("reconcileLedger — WALLET_LEDGER_DRIFT", () => {
  const drift = (findings: LedgerReconciliationFinding[]) =>
    ofType(findings, ReconciliationFindingType.WALLET_LEDGER_DRIFT);

  it("reports nothing when a real top-up moved both the balance and the ledger", async () => {
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "20000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    await settleWalletTopup(prisma, topup.id, { amount: "20000" });

    // The ordinary post-M3 state: the buyer's balance and the control account
    // that mirrors it were moved by the same event.
    const findings = await reconcileLedger(prisma);

    expect(drift(findings)).toEqual([]);
  });

  it("reports nothing on an empty shop, where both sides are genuinely zero", async () => {
    const findings = await reconcileLedger(prisma);

    expect(drift(findings)).toEqual([]);
  });

  it("detects a balance credited without a matching ledger posting", async () => {
    // Written straight onto the row, bypassing `adjustWallet` entirely — the
    // shape real drift takes (a hand-edited balance, or a credit path that
    // forgot to post).
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "5000" } });

    const findings = await reconcileLedger(prisma);

    const found = drift(findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      type: ReconciliationFindingType.WALLET_LEDGER_DRIFT,
      entity: "wallet_liability",
      entityId: "IDR",
      expected: "5000",
      actual: "0",
      difference: "5000",
      currency: "IDR",
      severity: ReconciliationSeverity.CRITICAL,
    });
    expect(found[0]!.reference).toContain("wallet_liability.idr");
  });

  it("detects USDT drift independently of IDR, and never blends the two", async () => {
    await prisma.user.update({
      where: { id: sample.user.id },
      data: { walletBalanceUsdt: "12.5" },
    });

    const findings = await reconcileLedger(prisma);

    const found = drift(findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      entityId: "USDT",
      expected: "12.5",
      actual: "0",
      difference: "12.5",
      currency: "USDT",
    });
  });

  it("reports nothing while an unsettled order holds wallet credit spent at checkout", async () => {
    // The state every live shop is in between a buyer paying with credit and an
    // admin approving the order: the balance is already down by 2.00, and the
    // ledger will not hear about it until settlement posts `order:{id}:payment`.
    // Reporting that as drift is a false positive that fires on every ordinary
    // checkout — which is what trains admins to ignore this alert.
    const order = await makeInFlightWalletSpendOrder("2.00");

    const findings = await reconcileLedger(prisma);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).toString()).toBe("18");
    expect(order.status).toBe(OrderStatus.PENDING_VERIFICATION);
    expect(drift(findings)).toEqual([]);
  });

  it("reports nothing once that unsettled order's wallet hold has been released", async () => {
    const order = await makeInFlightWalletSpendOrder("2.00");
    // Rejected before it ever settled: `releaseOrderHolds` credits the 2.00
    // back and `postOrderHoldReleasePosting` deliberately posts nothing (the
    // debit was never posted either). The hold has stopped being in flight, so
    // counting it a second time would invent drift in the opposite direction.
    await rejectOrder(prisma, order.id, { adminId: ADMIN_ID, reason: "out of stock" });

    const findings = await reconcileLedger(prisma);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).toString()).toBe("20");
    expect(drift(findings)).toEqual([]);
  });

  it("reports nothing once that order settles and its wallet leg is posted", async () => {
    const order = await makeInFlightWalletSpendOrder("2.00");
    // Settlement debits `wallet_liability.idr` by the 2.00 the buyer spent, via
    // `postOrderPaymentPosting`'s wallet leg. The hold has been booked, so it
    // must stop counting as in flight — counting it twice would report the
    // settled order's own wallet spend as drift.
    await approveOrder(prisma, order.id, { adminId: ADMIN_ID });
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.DELIVERED);

    const findings = await reconcileLedger(prisma);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).toString()).toBe("18");
    expect(drift(findings)).toEqual([]);
  });

  it("still reports real drift that coexists with an in-flight wallet hold", async () => {
    await makeInFlightWalletSpendOrder("2.00");
    // 1.00 leaves the buyer's balance with no movement row and no posting — the
    // hand-edit case this check exists for. The in-flight term must reconcile
    // the 2.00 hold and nothing else, or a real loss hides behind it.
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "17.00" } });

    const findings = await reconcileLedger(prisma);

    const found = drift(findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      entityId: "IDR",
      expected: "19",
      actual: "20",
      difference: "-1",
      currency: "IDR",
    });
  });

  it("reports the ledger side as larger when the ledger over-records", async () => {
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "20000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    await settleWalletTopup(prisma, topup.id, { amount: "20000" });
    // The buyer's balance was spent down without the ledger hearing about it.
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "15000" } });

    const findings = await reconcileLedger(prisma);

    const found = drift(findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      expected: "15000",
      actual: "20000",
      // Signed, so the direction of the drift is readable from the number.
      difference: "-5000",
    });
  });
});

// ── 4. DUPLICATE_PROVIDER_TRANSACTION ──────────────────────────────────────

describe("reconcileLedger — DUPLICATE_PROVIDER_TRANSACTION", () => {
  const duplicates = (findings: LedgerReconciliationFinding[]) =>
    ofType(findings, ReconciliationFindingType.DUPLICATE_PROVIDER_TRANSACTION);

  /** One PENDING payment attempt against an order, at a chosen provider ref. */
  async function makePayment(orderId: number, providerTransactionId: string | null) {
    return prisma.payment.create({
      data: {
        orderId,
        method: PaymentMethod.TOKOPAY,
        status: "PENDING",
        amount: "5.00",
        currency: "IDR",
        providerTransactionId,
      },
    });
  }

  it("reports nothing when every provider transaction id is distinct", async () => {
    const order = await makeDeliveredOrder();
    await makePayment(order.id, "PROVIDER-TX-1");
    await makePayment(order.id, "PROVIDER-TX-2");

    const findings = await reconcileLedger(prisma);

    expect(duplicates(findings)).toEqual([]);
  });

  it("never flags two null provider transaction ids as a duplicate", async () => {
    const order = await makeDeliveredOrder();
    // Legitimately distinct per the schema's own doc comment: a rail that never
    // captured a reference leaves null, and any number of nulls coexist.
    await makePayment(order.id, null);
    await makePayment(order.id, null);

    const findings = await reconcileLedger(prisma);

    expect(duplicates(findings)).toEqual([]);
  });

  it("detects a genuine duplicate written around the unique index", async () => {
    const order = await makeDeliveredOrder();
    // The only way this state can exist is the one the check defends against:
    // something wrote without the constraint (a manual edit, a migration
    // inconsistency). Dropped and restored inside this one test so no other
    // case runs against a schema missing its constraint.
    await prisma.$executeRawUnsafe(`DROP INDEX "ix_payments_method_provider_txn"`);
    try {
      await makePayment(order.id, "PROVIDER-TX-DUPE");
      await makePayment(order.id, "PROVIDER-TX-DUPE");

      const findings = await reconcileLedger(prisma);

      const found = duplicates(findings);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        type: ReconciliationFindingType.DUPLICATE_PROVIDER_TRANSACTION,
        entity: "payment",
        entityId: `${PaymentMethod.TOKOPAY}:PROVIDER-TX-DUPE`,
        expected: "1",
        actual: "2",
        difference: null,
        currency: null,
        severity: ReconciliationSeverity.CRITICAL,
      });
      expect(found[0]!.reference).toContain("PROVIDER-TX-DUPE");
    } finally {
      await prisma.payment.deleteMany();
      await prisma.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "ix_payments_method_provider_txn" ON "payments" ("method", "provider_transaction_id")`,
      );
    }
  });
});

// ── 5. REFUND_AMOUNT_MISMATCH ──────────────────────────────────────────────

describe("reconcileLedger — REFUND_AMOUNT_MISMATCH", () => {
  const mismatches = (findings: LedgerReconciliationFinding[]) =>
    ofType(findings, ReconciliationFindingType.REFUND_AMOUNT_MISMATCH);

  async function makeExecutedRefund(amount: string) {
    const order = await makeDeliveredOrder();
    const refund = await makeProcessingRefund(order.id, amount);
    return executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount,
      executedBy: ADMIN_ID,
    });
  }

  it("reports nothing for a payout whose posting records the same amount", async () => {
    await makeExecutedRefund("2.00");

    const findings = await reconcileLedger(prisma);

    expect(mismatches(findings)).toEqual([]);
  });

  it("detects a payout row whose amount was changed after it was posted", async () => {
    const execution = await makeExecutedRefund("2.00");
    // `postFinancialTransaction` will not write an unbalanced posting, so a
    // mismatched posting cannot be built through the API at all. What CAN
    // happen — and is what this check defends against — is the payout row
    // itself being rewritten after the fact.
    await prisma.refundExecution.update({
      where: { id: execution.id },
      data: { amount: "3.00" },
    });

    const findings = await reconcileLedger(prisma);

    const found = mismatches(findings);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      type: ReconciliationFindingType.REFUND_AMOUNT_MISMATCH,
      entity: "refund_execution",
      entityId: String(execution.id),
      expected: "3",
      actual: "2",
      difference: "1",
      currency: "IDR",
      severity: ReconciliationSeverity.CRITICAL,
    });
  });
});

// ── 6. Whole-function shape ────────────────────────────────────────────────

describe("reconcileLedger — overall", () => {
  it("returns an empty array for a shop whose books are clean", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    await setPaidAt(order.id, AFTER_ANCHOR);

    expect(await reconcileLedger(prisma)).toEqual([]);
  });

  it("returns findings from several checks at once, each with its own type", async () => {
    await anchorLedger();
    const order = await makeDeliveredOrder();
    await erasePosting(`order:${order.id}:payment`);
    await setPaidAt(order.id, AFTER_ANCHOR);
    await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "5000" } });

    const findings = await reconcileLedger(prisma);

    expect(findings.map((f) => f.type).sort()).toEqual(
      [
        ReconciliationFindingType.LEDGER_POSTING_MISSING,
        ReconciliationFindingType.WALLET_LEDGER_DRIFT,
      ].sort(),
    );
    // Every finding carries the moment it was detected, so a report can say
    // when the books were last checked without a second clock read per row.
    for (const finding of findings) expect(finding.detectedAt).toBeInstanceOf(Date);
  });
});
