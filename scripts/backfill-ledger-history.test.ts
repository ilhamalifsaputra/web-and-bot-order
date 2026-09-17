/**
 * Historical ledger backfill (Financial Ledger M10) — `backfillLedgerHistory`.
 *
 * The thing worth proving here is COMPLETENESS, not that the script runs. So
 * the fixture is built the only way that can prove it: every financial event
 * in it is produced by the REAL production path that raises it
 * (`approveOrder`, `settlePaidOrder`, `settleWalletTopup`,
 * `creditUnderpaidTopupAnyway`, `maybePayReferralCommission`,
 * `refundUnderpaidOrder`, `creditOrderToBalance`, `rejectOrder`,
 * `executeRefund`, plus the adjustWallet+post pair both admin-adjust call sites
 * make), the postings those paths made are SNAPSHOTTED, the ledger is then
 * erased and the operational rows back-dated — which is exactly what a shop
 * whose history predates the ledger looks like — and the backfill has to put
 * the books back.
 *
 * That gives three assertions no hand-written fixture could:
 *
 * 1. **Shape parity.** The restored postings are compared field by field
 *    against what the real-time functions actually produced, so a backfill that
 *    posted a plausible-but-different entry list fails. Nothing in this file
 *    hard-codes an expected account pair; the production code is the oracle.
 * 2. **No fabricated timestamps.** Every operational row is back-dated to one
 *    known instant, and every restored posting's `occurredAt` is asserted to be
 *    that instant — so a backfill that stamped `now()` fails loudly instead of
 *    quietly mis-dating a shop's whole history.
 * 3. **Zero reconciliation findings.** `reconcileLedger` (M5) is run against
 *    the backfilled database and must report nothing. That is the real test of
 *    completeness: a category the backfill forgot shows up as
 *    `LEDGER_POSTING_MISSING`, and a wallet credit it forgot shows up as
 *    `WALLET_LEDGER_DRIFT`, because the backfill moves the cutover boundary
 *    back over the whole history it just posted.
 *
 * The negative cases get their own fixtures, because each is a row the script
 * must refuse to guess at rather than force through a posting function: a
 * DELIVERED order with no payment timestamp, an `admin_adjust` movement with no
 * acting admin, and a wallet hold released on an order that never settled (the
 * one case where "posted nothing" is the correct answer, not a gap).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  DeliveryType,
  OrderStatus,
  PaymentMethod,
  ProductType,
  RefundExecutionMethod,
  RefundStatus,
} from "@app/core/enums";
import { makeTestDb, type TestDb } from "../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../tests/helpers/sampleData";
import {
  adjustWallet,
  approveOrder,
  attachPaymentProof,
  bulkAddStock,
  createCatalogProduct,
  createCategory,
  createDenomination,
  createOrderDirect,
  createRefund,
  createWalletTopupOrder,
  creditOrderToBalance,
  creditUnderpaidTopupAnyway,
  executeRefund,
  getOrder,
  markOrderUnderpaid,
  maybePayReferralCommission,
  postWalletAdjustmentPosting,
  reconcileLedger,
  refundUnderpaidOrder,
  rejectOrder,
  seedChartOfAccounts,
  setSetting,
  settlePaidOrder,
  settleWalletTopup,
  transitionRefundStatus,
  upsertUser,
  USD_IDR_RATE_KEY,
} from "@app/db";
import { backfillLedgerHistory, formatBackfillReport, type BackfillReport } from "./backfill-ledger-history";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let ADMIN_ID: number;

/**
 * The one instant every operational row in the fixture is back-dated to.
 *
 * A single value on purpose: it makes "did the backfill date this posting from
 * the row, or from the clock?" a single exact comparison per posting instead of
 * a per-row bookkeeping exercise.
 */
const HISTORY_AT = new Date("2025-03-04T05:06:07.000Z");

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
      telegramId: 9_100_000_001,
      username: "backfill-admin",
      fullName: "Backfill Admin",
      role: "ADMIN",
      referralCode: `bf${Math.random()}`,
    },
  });
  ADMIN_ID = admin.id;
});

// ── Fixture builders (every one walks a real production path) ──────────────

/** The buyer row as it stands NOW — `createOrderDirect` checks affordability
 *  against the balance it is handed, not against the database. */
const freshBuyer = async (userId: number) =>
  prisma.user.findUniqueOrThrow({ where: { id: userId } });

/** An order at PENDING_VERIFICATION, the state approveOrder/settlePaidOrder take. */
async function orderAwaitingVerification(args: {
  userId: number;
  productId: number;
  walletAmount?: Decimal.Value;
}) {
  const buyer = await freshBuyer(args.userId);
  const created = await createOrderDirect(prisma, {
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: args.productId,
    quantity: 1,
    walletAmount: args.walletAmount,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  return (await getOrder(prisma, created!.id))!;
}

/** A delivered product order, settled the way a real buyer's is. */
async function deliveredOrder(args: {
  userId: number;
  productId: number;
  walletAmount?: Decimal.Value;
}) {
  const order = await orderAwaitingVerification(args);
  await approveOrder(prisma, order.id, { adminId: ADMIN_ID });
  return (await getOrder(prisma, order.id))!;
}

/** A settled IDR wallet top-up — real money in, real credit out. */
async function settledTopup(userId: number, amount: string) {
  const topup = await createWalletTopupOrder(prisma, {
    userId,
    amount,
    currency: "IDR",
    method: PaymentMethod.TOKOPAY,
  });
  await settleWalletTopup(prisma, topup.id, { amount });
  return topup;
}

/** A hand-made wallet adjustment, exactly as web-admin's users route and the
 *  bot's /wallet command make it: one `adjustWallet` plus one posting, in one
 *  transaction. */
async function adjustByHand(userId: number, delta: string) {
  return prisma.$transaction(async (tx) => {
    const { transactionId } = await adjustWallet(tx, userId, delta, {
      reason: "admin_adjust",
      adminId: ADMIN_ID,
      currency: "IDR",
      allowNegative: true,
    });
    await postWalletAdjustmentPosting(tx, {
      walletTransactionId: transactionId,
      adminId: ADMIN_ID,
      occurredAt: new Date(),
    });
    return transactionId;
  });
}

/** A manual-delivery SKU, so `settlePaidOrder` takes its MANUAL branch. */
async function manualDenomination(price = "10.00") {
  const category = await createCategory(prisma, `manual-${Math.random()}`);
  const parent = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Product ${Math.random()}`,
  });
  return createDenomination(prisma, {
    productId: parent.id,
    name: "Manual Denom",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price,
    warrantyDays: 30,
    deliveryType: DeliveryType.MANUAL,
  });
}

/** An auto-delivery SKU priced high enough that a referral commission on it
 *  survives the 4-decimal-place quantize after the IDR→USDT conversion. */
async function pricyDenomination(price = "500000") {
  const category = await createCategory(prisma, `pricy-${Math.random()}`);
  const parent = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Pricy Product ${Math.random()}`,
  });
  const denomination = await createDenomination(prisma, {
    productId: parent.id,
    name: "Pricy Denom",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price,
    warrantyDays: 30,
  });
  await bulkAddStock(prisma, denomination.id, [`pricy-${denomination.id}@example.com:pwd`]);
  return denomination;
}

/** A Refund in PROCESSING — the only state `executeRefund` accepts. */
async function processingRefund(orderId: number, amount: string) {
  const refund = await createRefund(prisma, {
    orderId,
    amount,
    currency: "IDR",
    adminId: ADMIN_ID,
  });
  await transitionRefundStatus(prisma, {
    refundId: refund.id,
    from: RefundStatus.PENDING,
    to: RefundStatus.PROCESSING,
    adminId: ADMIN_ID,
  });
  return refund;
}

/**
 * A whole shop's financial history, produced entirely by production code: at
 * least one event of every category the backfill claims to cover, plus the two
 * cases where the correct answer is "post nothing".
 */
async function buildHistoricalShop() {
  // Referral commission converts an IDR order into USDT, so the rate has to be
  // readable — `resetDb` wipes settings, so it is set per fixture.
  await setSetting(prisma, USD_IDR_RATE_KEY, "16000");

  // Credit to spend at checkout, and a settled top-up of its own (category 2).
  const topup = await settledTopup(sample.user.id, "20000");

  // Category 1: a gateway-only sale, and a sale part-paid from wallet credit.
  const gatewaySale = await deliveredOrder({
    userId: sample.user.id,
    productId: sample.product.id,
  });
  const walletSale = await deliveredOrder({
    userId: sample.user.id,
    productId: sample.product.id,
    walletAmount: "2.00",
  });

  // Category 3: a top-up whose money arrived short, credited anyway.
  const shortTopup = await createWalletTopupOrder(prisma, {
    userId: sample.user.id,
    amount: "20000",
    currency: "IDR",
    method: PaymentMethod.TOKOPAY,
  });
  expect(
    await markOrderUnderpaid(prisma, {
      orderId: shortTopup.id,
      gateway: "TokoPay",
      receivedAmount: "18500",
      expectedAmount: shortTopup.totalAmount,
    }),
  ).toBe(true);
  await creditUnderpaidTopupAnyway(prisma, { orderId: shortTopup.id, adminId: ADMIN_ID });

  // Category 4: two hand-made adjustments, one each way, because the posting's
  // debit/credit order follows the movement's sign.
  await adjustByHand(sample.user.id, "25000");
  await adjustByHand(sample.user.id, "-5000");

  // Category 5: a referral commission, paid by the real delivery path.
  const referrer = await upsertUser(prisma, {
    telegramId: 9_100_000_002,
    username: "referrer",
    fullName: "Referrer",
  });
  const referee = await upsertUser(prisma, {
    telegramId: 9_100_000_003,
    username: "referee",
    fullName: "Referee",
  });
  await prisma.user.update({ where: { id: referee.id }, data: { referredById: referrer.id } });
  const pricy = await pricyDenomination();
  const refereeSale = await deliveredOrder({ userId: referee.id, productId: pricy.id });

  // Category 6a: an underpaid crypto deposit handed back as wallet credit.
  const underpaidSale = await orderAwaitingVerification({
    userId: sample.user.id,
    productId: sample.product.id,
  });
  await prisma.order.update({
    where: { id: underpaidSale.id },
    data: { status: OrderStatus.UNDERPAID },
  });
  await prisma.processedBinanceTx.create({
    data: {
      binanceTxId: `UNDERPAID-${underpaidSale.id}`,
      orderId: underpaidSale.id,
      outcome: "underpaid",
      amount: "2.0000",
    },
  });
  await refundUnderpaidOrder(prisma, { orderId: underpaidSale.id, adminId: ADMIN_ID });

  // Category 6b + category 7's posting branch: a settled manual order credited
  // back, which both hands the external payment back as credit AND returns the
  // wallet hold whose revenue the settlement had already recognised.
  const manual = await manualDenomination();
  const manualSale = await orderAwaitingVerification({
    userId: sample.user.id,
    productId: manual.id,
    walletAmount: "2.00",
  });
  await settlePaidOrder(prisma, manualSale.id, { adminId: ADMIN_ID });
  await creditOrderToBalance(prisma, { orderId: manualSale.id, adminId: ADMIN_ID });

  // Category 7's "post nothing" branch: a hold released on an order that never
  // settled, so the ledger never recorded the debit there is now nothing to
  // reverse.
  const rejectedSale = await orderAwaitingVerification({
    userId: sample.user.id,
    productId: sample.product.id,
    walletAmount: "1.00",
  });
  await rejectOrder(prisma, rejectedSale.id, { adminId: ADMIN_ID, reason: "proof was not valid" });

  // Category 8: both payout methods. Partial amounts, so each order stays
  // DELIVERED and remains something `reconcileLedger` still checks afterwards.
  const walletRefund = await processingRefund(gatewaySale.id, "2.00");
  await executeRefund(prisma, {
    refundId: walletRefund.id,
    method: RefundExecutionMethod.WALLET,
    amount: "2.00",
    executedBy: ADMIN_ID,
  });
  const manualRefund = await processingRefund(walletSale.id, "1.00");
  await executeRefund(prisma, {
    refundId: manualRefund.id,
    method: RefundExecutionMethod.MANUAL_TRANSFER,
    amount: "1.00",
    proofFileId: "transfer-proof",
    executedBy: ADMIN_ID,
  });

  return {
    topup,
    gatewaySale,
    walletSale,
    shortTopup,
    refereeSale,
    underpaidSale,
    manualSale,
    rejectedSale,
  };
}

// ── Snapshot / erase / back-date helpers ───────────────────────────────────

interface PostingShape {
  type: string;
  referenceType: string;
  referenceId: number;
  idempotencyKey: string;
  description: string;
  entries: Array<{ code: string; direction: string; amount: string; currency: string }>;
}

/**
 * Every posting in the books, with its entries, in a stable order and WITHOUT
 * `id`/`postedAt`/`occurredAt` — the three fields that legitimately differ
 * between a real-time posting and the backfilled one that replaces it
 * (`occurredAt` gets its own, exact assertion).
 */
async function snapshotPostings(): Promise<PostingShape[]> {
  const transactions = await prisma.financialTransaction.findMany({
    orderBy: { idempotencyKey: "asc" },
  });
  const entries = await prisma.ledgerEntry.findMany({
    include: { account: true },
    orderBy: { id: "asc" },
  });
  return transactions.map((transaction) => ({
    type: transaction.type,
    referenceType: transaction.referenceType,
    referenceId: transaction.referenceId,
    idempotencyKey: transaction.idempotencyKey,
    description: transaction.description,
    entries: entries
      .filter((entry) => entry.financialTransactionId === transaction.id)
      .map((entry) => ({
        code: entry.account.code,
        direction: entry.direction,
        amount: new Decimal(entry.amount).toString(),
        currency: entry.currency,
      })),
  }));
}

/**
 * Erase the ledger, leaving every money movement that produced it in place —
 * the state a shop is in for everything that happened before the ledger
 * existed. Deleted directly because the ledger is append-only by design and has
 * no delete path, which is why this can only ever be a test fixture.
 */
async function eraseLedger() {
  await prisma.ledgerEntry.deleteMany();
  await prisma.financialTransaction.deleteMany();
}

/** Move every operational timestamp the backfill may read back to one instant. */
async function backDateHistory(at: Date = HISTORY_AT) {
  await prisma.order.updateMany({
    where: { paidAt: { not: null } },
    data: { paidAt: at },
  });
  await prisma.order.updateMany({
    where: { deliveredAt: { not: null } },
    data: { deliveredAt: at },
  });
  await prisma.walletTransaction.updateMany({ data: { createdAt: at } });
  await prisma.refundExecution.updateMany({ data: { executedAt: at, createdAt: at } });
}

const keysOf = (report: BackfillReport) => report.categories.map((category) => category.category);
const categoryOf = (report: BackfillReport, name: string) => {
  const found = report.categories.find((category) => category.category === name);
  expect(found, `no category "${name}" in the report; got ${keysOf(report).join(", ")}`).toBeDefined();
  return found!;
};

// ── 1. A shop whose entire history predates the ledger ─────────────────────

describe("backfillLedgerHistory — a shop whose whole history predates the ledger", () => {
  let expected: PostingShape[];

  beforeEach(async () => {
    await buildHistoricalShop();
    expected = await snapshotPostings();
    // Sanity: the fixture has to have produced real books, or every assertion
    // below would pass vacuously against two empty sets.
    expect(expected.length).toBeGreaterThan(10);
    await eraseLedger();
    await backDateHistory();
    expect(await prisma.financialTransaction.count()).toBe(0);
  });

  it("restores every posting the real-time path made, in the same shape", async () => {
    await backfillLedgerHistory(prisma);

    expect(await snapshotPostings()).toEqual(expected);
  });

  it("dates every restored posting from the historical row, never from the run", async () => {
    await backfillLedgerHistory(prisma);

    const occurredAt = await prisma.financialTransaction.findMany({
      select: { idempotencyKey: true, occurredAt: true },
    });
    expect(occurredAt.length).toBe(expected.length);
    for (const posting of occurredAt) {
      expect(posting.occurredAt.getTime(), `posting "${posting.idempotencyKey}" was not dated from its row`).toBe(
        HISTORY_AT.getTime(),
      );
    }
  });

  it("leaves reconcileLedger with nothing at all to report", async () => {
    await backfillLedgerHistory(prisma);

    expect(await reconcileLedger(prisma)).toEqual([]);
  });

  it("moves the reconciliation cutover back over the history it posted", async () => {
    const report = await backfillLedgerHistory(prisma);

    expect(report.cutoverBefore).toBeNull();
    expect(report.cutoverAfter?.getTime()).toBe(HISTORY_AT.getTime());
  });

  it("posts nothing new on a second run and leaves the first run's rows untouched", async () => {
    const first = await backfillLedgerHistory(prisma);
    const before = await prisma.financialTransaction.findMany({
      select: { id: true, idempotencyKey: true },
      orderBy: { id: "asc" },
    });

    const second = await backfillLedgerHistory(prisma);

    expect(second.totals.posted).toBe(0);
    expect(second.totals.alreadyPosted).toBe(first.totals.posted);
    expect(
      await prisma.financialTransaction.findMany({
        select: { id: true, idempotencyKey: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
    expect(await prisma.ledgerEntry.count()).toBe(
      (await snapshotPostings()).reduce((total, posting) => total + posting.entries.length, 0),
    );
  });

  it("reports what it posted per category, and refuses nothing in a healthy history", async () => {
    const report = await backfillLedgerHistory(prisma);

    expect(report.totals.unprocessable).toBe(0);
    expect(report.totals.posted).toBe(expected.length);
    // Every category the script claims to cover is in the report, whether or
    // not this fixture happened to exercise it.
    expect(keysOf(report)).toEqual([
      "order_payment",
      "wallet_topup",
      "underpaid_topup_credit",
      "admin_wallet_adjustment",
      "referral_commission",
      "underpaid_order_credit",
      "unfulfilled_order_credit",
      "order_hold_release",
      "refund_payout",
    ]);
    expect(categoryOf(report, "order_payment").posted).toBe(4);
    expect(categoryOf(report, "wallet_topup").posted).toBe(1);
    expect(categoryOf(report, "underpaid_topup_credit").posted).toBe(1);
    expect(categoryOf(report, "admin_wallet_adjustment").posted).toBe(2);
    expect(categoryOf(report, "referral_commission").posted).toBe(1);
    expect(categoryOf(report, "underpaid_order_credit").posted).toBe(1);
    expect(categoryOf(report, "unfulfilled_order_credit").posted).toBe(1);
    expect(categoryOf(report, "refund_payout").posted).toBe(2);
    // Two holds released: one on a settled order (posts a revenue reversal),
    // one on an order that never settled (correctly posts nothing).
    const holds = categoryOf(report, "order_hold_release");
    expect(holds.examined).toBe(2);
    expect(holds.posted).toBe(1);
    expect(holds.postedNothing).toBe(1);
  });

  it("pages through history in bounded batches without changing the result", async () => {
    const report = await backfillLedgerHistory(prisma, { batchSize: 1 });

    expect(report.totals.posted).toBe(expected.length);
    expect(await snapshotPostings()).toEqual(expected);
    expect(await reconcileLedger(prisma)).toEqual([]);
  });

});

// ── 2. Rows the real-time path already posted ──────────────────────────────

describe("backfillLedgerHistory — events the ledger already recorded", () => {
  it("leaves an already-posted order alone instead of posting it twice", async () => {
    const order = await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    const key = `order:${order.id}:payment`;
    const before = await prisma.financialTransaction.findMany({ where: { idempotencyKey: key } });
    expect(before).toHaveLength(1);

    const report = await backfillLedgerHistory(prisma);

    const after = await prisma.financialTransaction.findMany({ where: { idempotencyKey: key } });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.occurredAt.getTime()).toBe(before[0]!.occurredAt.getTime());
    expect(categoryOf(report, "order_payment").alreadyPosted).toBe(1);
    expect(categoryOf(report, "order_payment").posted).toBe(0);
  });
});

// ── 3. A payout recorded before the ledger existed ─────────────────────────

describe("backfillLedgerHistory — refund payouts older than the ledger itself", () => {
  it("reports one recorded before the ledger's first posting, because that should be impossible", async () => {
    // `RefundExecution` was introduced by this ledger build's own first commit,
    // so a payout row older than the ledger's earliest posting cannot have been
    // written by this application — a restored dump, or rows written around it.
    // The script posts it like any other payout and says so, rather than
    // silently treating it as ordinary history.
    const order = await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    const refund = await processingRefund(order.id, "2.00");
    const execution = await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });
    await prisma.refundExecution.update({
      where: { id: execution.id },
      data: { createdAt: new Date("2020-01-01T00:00:00.000Z") },
    });

    const report = await backfillLedgerHistory(prisma);

    expect(report.refundPayoutsPredatingLedger).toHaveLength(1);
    expect(report.refundPayoutsPredatingLedger[0]!.id).toBe(execution.id);
    expect(formatBackfillReport(report)).toContain("INVESTIGATE");
  });

  it("reports none when every payout is younger than the ledger's first posting", async () => {
    const order = await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    const refund = await processingRefund(order.id, "2.00");
    await executeRefund(prisma, {
      refundId: refund.id,
      method: RefundExecutionMethod.WALLET,
      amount: "2.00",
      executedBy: ADMIN_ID,
    });

    const report = await backfillLedgerHistory(prisma);

    // Non-null, so the comparison really ran rather than being skipped for want
    // of a boundary to compare against.
    expect(report.cutoverBefore).not.toBeNull();
    expect(report.refundPayoutsPredatingLedger).toEqual([]);
  });
});

// ── 4. Rows it refuses to guess at ─────────────────────────────────────────

describe("backfillLedgerHistory — rows it refuses to guess at", () => {
  it("reports a DELIVERED order with no payment timestamp instead of inventing one", async () => {
    const order = await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    await eraseLedger();
    // A DELIVERED order with no `paidAt` cannot have been settled by any path
    // in this codebase — every one of them stamps `paidAt` in the same
    // transaction as the posting. There is no honest instant to date a posting
    // from, so the script must say so rather than reach for `deliveredAt`.
    await prisma.order.update({ where: { id: order.id }, data: { paidAt: null } });

    const report = await backfillLedgerHistory(prisma);

    const category = categoryOf(report, "order_payment");
    expect(category.posted).toBe(0);
    expect(category.unprocessable).toHaveLength(1);
    expect(category.unprocessable[0]).toMatchObject({
      entity: "order",
      entityId: order.id,
    });
    expect(category.unprocessable[0]!.problem).toMatch(/paid/i);
    expect(await prisma.financialTransaction.count()).toBe(0);
  });

  it("reports an admin adjustment with no acting admin instead of posting it", async () => {
    const transactionId = await adjustByHand(sample.user.id, "25000");
    await eraseLedger();
    // The posting's own back-pointer IS the acting admin, so a movement with
    // none cannot be reconstructed — and guessing an admin id would put a name
    // on a money decision nobody made.
    await prisma.walletTransaction.update({
      where: { id: transactionId },
      data: { adminId: null },
    });

    const report = await backfillLedgerHistory(prisma);

    const category = categoryOf(report, "admin_wallet_adjustment");
    expect(category.posted).toBe(0);
    expect(category.unprocessable).toHaveLength(1);
    expect(category.unprocessable[0]).toMatchObject({
      entity: "wallet_transaction",
      entityId: transactionId,
    });
    expect(await prisma.financialTransaction.count()).toBe(0);
  });

  it("reports an admin adjustment attached to a product order as a shape it does not know", async () => {
    // `admin_adjust` with an `orderId` is written by exactly one path
    // (`creditUnderpaidTopupAnyway`, on a WALLET_TOPUP order). The same reason
    // code on a PRODUCT order is a shape no production path produces, and the
    // two possible postings for it differ in which account the money came from
    // — so it is reported, not guessed.
    const order = await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    const movement = await adjustByHand(sample.user.id, "1000");
    await prisma.walletTransaction.update({
      where: { id: movement },
      data: { orderId: order.id },
    });
    await eraseLedger();

    const report = await backfillLedgerHistory(prisma);

    const category = categoryOf(report, "underpaid_topup_credit");
    expect(category.examined).toBe(1);
    expect(category.posted).toBe(0);
    expect(category.unprocessable).toHaveLength(1);
    expect(category.unprocessable[0]!.problem).toMatch(/top-?up/i);
  });
});

// ── 5. Preflight ───────────────────────────────────────────────────────────

describe("backfillLedgerHistory — preflight", () => {
  it("refuses to run at all when the chart of accounts is incomplete", async () => {
    // Without this refusal the run would look like a success: every posting
    // would be skipped by `postOrSkipMissingAccount`, reported as "nothing to
    // post", and an operator would conclude their history held no events.
    await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    await eraseLedger();
    await prisma.ledgerAccount.deleteMany({ where: { code: "sales_revenue.idr" } });

    await expect(backfillLedgerHistory(prisma)).rejects.toThrow(/sales_revenue\.idr/);

    expect(await prisma.financialTransaction.count()).toBe(0);
    // Put the account back by hand: `resetDb` only re-seeds the chart when it is
    // completely empty (re-seeding 15 rows in every beforeEach across the whole
    // suite would cost far more than the one count check that skips it), so a
    // PARTIAL deletion would otherwise leak into every later test in this file.
    await seedChartOfAccounts(prisma);
  });
});

// ── 6. The printed report ──────────────────────────────────────────────────

describe("formatBackfillReport", () => {
  it("prints a per-category table, the cutover it moved, and what to do next", async () => {
    await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    await eraseLedger();
    await backDateHistory();

    const text = formatBackfillReport(await backfillLedgerHistory(prisma));

    expect(text).toContain("order_payment");
    expect(text).toContain("refund_payout");
    expect(text).toContain(HISTORY_AT.toISOString());
    // The operator's next step, because a backfill that moves the cutover back
    // has changed what reconciliation covers.
    expect(text).toMatch(/reconcil/i);
  });

  it("names every row it could not process, so each one can be investigated", async () => {
    const order = await deliveredOrder({ userId: sample.user.id, productId: sample.product.id });
    await eraseLedger();
    await prisma.order.update({ where: { id: order.id }, data: { paidAt: null } });

    const text = formatBackfillReport(await backfillLedgerHistory(prisma));

    expect(text).toContain("COULD NOT PROCESS");
    expect(text).toContain(order.orderCode);
  });
});
