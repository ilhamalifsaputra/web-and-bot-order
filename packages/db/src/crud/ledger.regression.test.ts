/**
 * Financial Ledger M8 — the end-to-end regression suite.
 *
 * Every other ledger test file in this repo tests ONE layer in isolation:
 * `ledger.test.ts` the posting service, `ledger_postings.test.ts` the entry
 * lists each event builds, `refundExecution.test.ts` the payout path,
 * `reconcileLedger.test.ts` the drift detector, `revenue.test.ts` and
 * `revenue.sql-crosscheck.test.ts` the dashboard aggregates. Each one can pass
 * while the CHAIN between them is wrong, because none of them ever asks the
 * question an operator actually asks:
 *
 *   one real order walks the whole path — checkout, payment, settlement,
 *   posting, refund, reconciliation — and at the end, do the ledger, the
 *   dashboard figures and the drift detector all describe the SAME money?
 *
 * That is the only thing this file tests. Each scenario drives the real
 * production functions in production order and then asserts all three views at
 * once:
 *
 *  1. **The ledger**: which postings exist, under which idempotency keys, with
 *     which accounts, directions, amounts and currencies, and balanced per
 *     currency.
 *  2. **The dashboard**: `revenueSummary` (Revenue Today / Gross Sales),
 *     `grossSalesForNetSales` − `refundTotalsSince` (Net Sales),
 *     `ordersByStatusSince` (the Orders funnel), `revenueByDay` /
 *     `combinedRevenueByDay` (the Sales Analytics series), `botOverallStats`
 *     and `shopFulfilmentStats`. Semantics come from
 *     `docs/sales-metrics-contract.md` (M7); where a figure here looks
 *     surprising, that document's row for it says why, and the comment cites it.
 *  3. **`reconcileLedger`**: zero findings. This is the assertion that makes the
 *     other two trustworthy — a suite that only checked figures it computed
 *     itself would agree with its own mistakes.
 *
 * Coverage is deliberately NOT duplicated from the per-layer files. Where a
 * property is already pinned at unit level (the ledger's own idempotency key
 * dedupe, WALLET vs MANUAL_TRANSFER account choice, TokoPay's fee columns, the
 * in-flight-hold reconciling term), this file drives it through the real
 * end-to-end path instead and asserts the figures the unit tests never look at.
 *
 * Fixtures walk the real path (`createOrderDirect` → `attachPaymentProof` →
 * `approveOrder`, `createWalletTopupOrder` → `settleWalletTopup`,
 * `createRefund` → `transitionRefundStatus` → `executeRefund`) rather than
 * writing rows by hand. Timing is the thing under test in half these scenarios
 * — the wallet balance moves at checkout while the ledger moves at settlement,
 * and a sale and its refund can land on different days — and a hand-written
 * fixture is exactly how that timing gets quietly wrong.
 *
 * Two dates are set by hand, and only two: `Order.deliveredAt`/`paidAt` are
 * back-dated in the "refunded on a later day" scenario, because no production
 * function lets a test place a settlement on yesterday.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  DeliveryType,
  FinancialTransactionType,
  OrderCurrency,
  OrderKind,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ProductType,
  RefundExecutionMethod,
  RefundExecutionStatus,
  RefundStatus,
} from "@app/core/enums";
import { computeQrisAdminFee, qrisChargeAmount } from "@app/core/payments/tokopay";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  approveOrder,
  attachPaymentProof,
  botOverallStats,
  bulkAddStock,
  cancelOrder,
  combinedRevenueByDay,
  createCatalogProduct,
  createCategory,
  createDenomination,
  createOrderDirect,
  createPaymentAttempt,
  createRefund,
  createWalletTopupOrder,
  deliverPaidTokopayOrder,
  executeRefund,
  expirePaymentAttempt,
  finalizeOrderPayment,
  getAccountBalance,
  getOrder,
  grossSalesForNetSales,
  ordersByStatusSince,
  postOrderPaymentPosting,
  reconcileLedger,
  refundTotalsSince,
  revenueByDay,
  revenueSummary,
  settleWalletTopup,
  shopFulfilmentStats,
  transitionRefundStatus,
  userTotalSpent,
  type LedgerReconciliationFinding,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

/** The acting admin for every audited call below — a real User row, because
 *  `audit_logs.admin_id` is a foreign key. */
let ADMIN_ID: number;

/** Rupiah per 1 USDT, for the one scenario that settles in USDT. A round number
 *  so the IDR-equivalent blend is checkable by eye as well as by Decimal. */
const USDT_RATE = "16000";

/**
 * The left edge of every "today" window below. Five minutes is wide enough to
 * contain a whole scenario's worth of real settlements (each of which stamps its
 * own wall-clock instant) and narrow enough that it can never reach back into
 * yesterday, which the back-dating scenario depends on.
 */
const WINDOW_MINUTES = 5;
const todayWindowStart = () => new Date(Date.now() - WINDOW_MINUTES * 60_000);

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
      telegramId: 9_000_000_008,
      username: "ledger-regression-admin",
      fullName: "Ledger Regression Admin",
      role: "ADMIN",
      referralCode: `lrg${Math.random()}`,
    },
  });
  ADMIN_ID = admin.id;
});

// ── Fixture builders ───────────────────────────────────────────────────────

/**
 * An order at PENDING_VERIFICATION, built the way a buyer builds one. The
 * buyer row is re-read first because `createOrderDirect` checks `walletAmount`
 * against the balance it is HANDED rather than against the row, so a fixture
 * that spends credit has to pass a fresh one.
 */
async function makeOrderAwaitingVerification(args: {
  productId?: number;
  walletAmount?: Decimal.Value;
} = {}) {
  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const created = await createOrderDirect(prisma, {
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: args.productId ?? sample.product.id,
    quantity: 1,
    walletAmount: args.walletAmount,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  return (await getOrder(prisma, created!.id))!;
}

/** A DELIVERED IDR product order whose `order:{id}:payment` posting is real. */
async function makeSettledIdrOrder(args: {
  productId?: number;
  walletAmount?: Decimal.Value;
} = {}) {
  const order = await makeOrderAwaitingVerification(args);
  await approveOrder(prisma, order.id, { adminId: ADMIN_ID });
  const settled = (await getOrder(prisma, order.id))!;
  expect(settled.status).toBe(OrderStatus.DELIVERED);
  return settled;
}

/**
 * An AUTO-delivery SKU priced in real Rupiah, with stock, so an order for it
 * can be approved. `buildSampleData`'s own product is priced `5.00`, which is a
 * USDT-shaped number: converted at a real fx rate it rounds to zero USDT, which
 * would make the currency-separation scenario assert on amounts too small to
 * mean anything. Anything that needs a realistic magnitude uses this instead.
 */
async function makeIdrPricedDenomination(price: string) {
  const category = await createCategory(prisma, `idr-priced-${Math.random()}`);
  const parent = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `IDR Priced Product ${Math.random()}`,
  });
  const denom = await createDenomination(prisma, {
    productId: parent.id,
    name: "IDR Priced Denom",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price,
    warrantyDays: 30,
    deliveryType: DeliveryType.AUTO,
  });
  await bulkAddStock(
    prisma,
    denom.id,
    Array.from({ length: 3 }, (_, i) => `idr-priced-${denom.id}-${i}@example.com:pwd`),
  );
  return denom;
}

/** A DELIVERED order settled in USDT, via the same path plus the payment choice
 *  `finalizeOrderPayment` stamps (currency + fxRate snapshot + rail). */
async function makeSettledUsdtOrder(productId?: number) {
  const created = await createOrderDirect(prisma, {
    user: sample.user,
    productId: productId ?? sample.product.id,
    quantity: 1,
  });
  await finalizeOrderPayment(prisma, created!.id, {
    currency: OrderCurrency.USDT,
    rate: USDT_RATE,
    method: PaymentMethod.BINANCE_INTERNAL,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-usdt-${created!.id}` });
  await approveOrder(prisma, created!.id, { adminId: ADMIN_ID });
  const settled = (await getOrder(prisma, created!.id))!;
  expect(settled.status).toBe(OrderStatus.DELIVERED);
  expect(settled.currency).toBe(OrderCurrency.USDT);
  expect(new Decimal(settled.fxRate!).toString()).toBe(new Decimal(USDT_RATE).toString());
  return settled;
}

/**
 * Fund the buyer's wallet the way a real buyer does — a settled `WALLET_TOPUP`
 * order, which moves `User.walletBalance` AND posts `wallet_liability.<ccy>` in
 * one settlement, so the books start in agreement. Deliberately not
 * `adjustWallet`: that moves only the balance, which would seed
 * `WALLET_LEDGER_DRIFT` before any scenario had run.
 */
async function fundWalletByTopup(amount: Decimal.Value, currency: "IDR" | "USDT" = "IDR") {
  const topup = await createWalletTopupOrder(prisma, {
    userId: sample.user.id,
    amount,
    currency,
    method: currency === "IDR" ? PaymentMethod.TOKOPAY : PaymentMethod.BINANCE_INTERNAL,
    ...(currency === "USDT" ? { rate: USDT_RATE } : {}),
  });
  await settleWalletTopup(prisma, topup.id, { amount });
  const settled = (await getOrder(prisma, topup.id))!;
  expect(settled.status).toBe(OrderStatus.DELIVERED);
  expect(settled.kind).toBe(OrderKind.WALLET_TOPUP);
  return settled;
}

/** A manual-delivery SKU, for the one order that must NOT auto-deliver. */
async function makeManualDenomination(price = "7500") {
  const category = await createCategory(prisma, `manual-regression-${Math.random()}`);
  const parent = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Regression Product ${Math.random()}`,
  });
  return createDenomination(prisma, {
    productId: parent.id,
    name: "Manual Regression Denom",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price,
    warrantyDays: 30,
    deliveryType: DeliveryType.MANUAL,
  });
}

/**
 * Pay a refund out for real: request → PROCESSING → payout. Returns the
 * `RefundExecution`, which is the row every refund figure on the dashboard is
 * derived from (never `Refund.amount` — see the metrics contract's "Refunds
 * Today" row).
 */
async function payOutRefund(args: {
  orderId: number;
  amount: Decimal.Value;
  currency?: string;
  method?: string;
}) {
  const currency = args.currency ?? OrderCurrency.IDR;
  const refund = await createRefund(prisma, {
    orderId: args.orderId,
    amount: args.amount,
    currency,
    adminId: ADMIN_ID,
  });
  await transitionRefundStatus(prisma, {
    refundId: refund.id,
    from: RefundStatus.PENDING,
    to: RefundStatus.PROCESSING,
    adminId: ADMIN_ID,
  });
  const method = args.method ?? RefundExecutionMethod.WALLET;
  const execution = await executeRefund(prisma, {
    refundId: refund.id,
    method,
    amount: args.amount,
    executedBy: ADMIN_ID,
    notes: "End-to-end regression payout.",
    ...(method === RefundExecutionMethod.MANUAL_TRANSFER ? { proofFileId: "transfer-proof" } : {}),
  });
  expect(execution.status).toBe(RefundExecutionStatus.COMPLETED);
  return execution;
}

// ── Assertion helpers ──────────────────────────────────────────────────────

/** One posting's entries, flattened into a readable, comparable shape. */
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

/** The single posting under an idempotency key, or a readable failure. */
async function postingByKey(idempotencyKey: string) {
  const posting = await prisma.financialTransaction.findUnique({ where: { idempotencyKey } });
  expect(posting, `no ledger posting found under idempotency key "${idempotencyKey}"`).not.toBeNull();
  return posting!;
}

/**
 * Debits equal credits inside every currency of one posting. Re-asserted per
 * scenario rather than trusted from the posting service's own tests: an
 * unbalanced entry list is rejected at write time, so it surfaces as a
 * settlement that threw somewhere this file does not otherwise look.
 */
async function expectBalancedPerCurrency(financialTransactionId: number) {
  const rows = await entriesOf(financialTransactionId);
  expect(rows.length, "a posting with no entries is not a posting").toBeGreaterThan(0);
  const sums = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const row of rows) {
    const sum = sums.get(row.currency) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    if (row.direction === "DEBIT") sum.debit = sum.debit.plus(row.amount);
    else sum.credit = sum.credit.plus(row.amount);
    sums.set(row.currency, sum);
  }
  for (const [currency, sum] of sums) {
    expect(sum.debit.toString(), `debits != credits in ${currency}`).toBe(sum.credit.toString());
  }
}

/** Every posting in the books right now, oldest first. */
const allPostings = () => prisma.financialTransaction.findMany({ orderBy: { id: "asc" } });

/**
 * `reconcileLedger` finds nothing. Printed as JSON on failure, because the
 * findings themselves are the diagnosis and a bare length assertion throws all
 * of it away.
 */
async function expectBooksReconcile() {
  const findings: LedgerReconciliationFinding[] = await reconcileLedger(prisma);
  expect(findings, `reconcileLedger reported drift: ${JSON.stringify(findings, null, 2)}`).toEqual([]);
  return findings;
}

/** Net Sales Today, computed exactly the way the dashboard route computes it:
 *  `grossSalesForNetSales` minus `refundTotalsSince`, per currency, never
 *  clamped at zero (see the metrics contract's "Net Sales Today" row). */
async function netSalesSince(since: Date) {
  const gross = await grossSalesForNetSales(prisma, since);
  const refunds = await refundTotalsSince(prisma, since);
  return {
    idr: gross.idr.minus(refunds.refunds_idr),
    usdt: gross.usdt.minus(refunds.refunds_usdt),
  };
}

/** One status's count out of `ordersByStatusSince`, zero when absent. */
function countIn(rows: { status: string; count: number }[], status: string) {
  return rows.find((row) => row.status === status)?.count ?? 0;
}

/** The buyer's current balances, as comparable strings. */
async function balances() {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  return {
    idr: new Decimal(user.walletBalance).toString(),
    usdt: new Decimal(user.walletBalanceUsdt).toString(),
  };
}

/** Today's bucket out of a `*ByDay` series, by its real UTC calendar key. */
function bucketFor<T extends { day: string }>(series: T[], at: Date): T {
  const key = at.toISOString().slice(0, 10);
  const bucket = series.find((row) => row.day === key);
  expect(bucket, `no bucket for ${key} in a series covering ${series[0]?.day}..${series.at(-1)?.day}`).toBeDefined();
  return bucket!;
}

// ── 1. A normal order and its payment ──────────────────────────────────────

describe("scenario 1 — a normal product order, paid and settled", () => {
  it("posts one ORDER_PAYMENT, shows up in every sales figure, and reconciles clean", async () => {
    const since = todayWindowStart();
    const order = await makeSettledIdrOrder();
    const total = new Decimal(order.totalAmount).toString();

    // ── the ledger ──
    const posting = await postingByKey(`order:${order.id}:payment`);
    expect(posting.type).toBe(FinancialTransactionType.ORDER_PAYMENT);
    expect(posting.referenceType).toBe("order");
    expect(posting.referenceId).toBe(order.id);
    // The posting is stamped with the order's own payment instant, not a second
    // clock read — which is what lets reconcileLedger compare the two.
    expect(posting.occurredAt.getTime()).toBe(order.paidAt!.getTime());
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: total, currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: total, currency: "IDR" },
    ]);
    await expectBalancedPerCurrency(posting.id);
    // Nothing else posted. A settlement that also booked, say, a fee would
    // still balance; only the count catches it.
    expect(await allPostings()).toHaveLength(1);
    // And the books say the same thing the entries do.
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(total);
    expect((await getAccountBalance(prisma, "provider_clearing.idr")).toString()).toBe(total);

    // ── the dashboard ──
    const revenue = await revenueSummary(prisma, since);
    expect(revenue.revenue_idr.toString()).toBe(total);
    expect(revenue.revenue_usdt.toString()).toBe("0");
    expect(revenue.orders).toBe(1);
    // No refund happened, so Gross and Net agree and Refunds Today is zero.
    expect((await grossSalesForNetSales(prisma, since)).idr.toString()).toBe(total);
    const refunds = await refundTotalsSince(prisma, since);
    expect(refunds.refunds_idr.toString()).toBe("0");
    expect((await netSalesSince(since)).idr.toString()).toBe(total);
    // The funnel counts it as placed-and-delivered today.
    const funnel = await ordersByStatusSince(prisma, since);
    expect(countIn(funnel, OrderStatus.DELIVERED)).toBe(1);
    // The Sales Analytics series agrees with the KPI, for today's UTC bucket.
    expect(bucketFor(await revenueByDay(prisma), order.deliveredAt!).revenue_idr).toBe(total);
    expect(bucketFor(await combinedRevenueByDay(prisma), order.deliveredAt!).revenueIdrEquiv).toBe(total);
    // Lifetime figures on the bot and the storefront home page see it too.
    const bot = await botOverallStats(prisma);
    expect(bot.revenue_idr.toString()).toBe(total);
    expect(bot.items_sold).toBe(1);
    const storefront = await shopFulfilmentStats(prisma);
    expect(storefront.deliveredOrders).toBe(1);
    expect(storefront.customers).toBe(1);
    // And the buyer's own "Total Spent".
    expect((await userTotalSpent(prisma, sample.user.id)).idr.toString()).toBe(total);

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 2. A redelivered webhook ───────────────────────────────────────────────

describe("scenario 2 — the same settlement arriving twice (a redelivered webhook)", () => {
  it("recognises the revenue once: one posting, one order in the funnel, no drift", async () => {
    const since = todayWindowStart();
    // The TokoPay rail is the honest shape of this failure: a gateway
    // re-POSTs the same callback, and the SAME trxId arrives twice.
    const created = await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    });
    await prisma.order.update({
      where: { id: created!.id },
      data: { paymentMethod: PaymentMethod.TOKOPAY },
    });
    const order = (await getOrder(prisma, created!.id))!;
    const total = new Decimal(order.totalAmount).toString();

    const first = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-redelivered",
      amount: qrisChargeAmount(order.totalAmount),
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-redelivered",
      amount: qrisChargeAmount(order.totalAmount),
    });
    expect(second.status).toBe("already_processed");

    // ── the ledger ──
    const postings = await allPostings();
    expect(postings).toHaveLength(1);
    expect(postings[0]!.idempotencyKey).toBe(`order:${order.id}:payment`);

    // That alone only proves the RAIL refused the replay — its idempotency
    // claim short-circuited before the posting was reached a second time. The
    // ledger's own key has to dedupe too, because it is the last line of
    // defence for a caller that does NOT short-circuit. Drive the posting
    // directly and require the SAME row back.
    const settled = (await getOrder(prisma, order.id))!;
    const replayed = await postOrderPaymentPosting(prisma, settled, settled.paidAt!);
    expect(replayed!.id).toBe(postings[0]!.id);
    expect(await allPostings()).toHaveLength(1);
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(total);

    // ── the dashboard ──
    const revenue = await revenueSummary(prisma, since);
    expect(revenue.revenue_idr.toString()).toBe(total);
    // The count is what a double-settlement would have doubled, and it is the
    // figure a per-layer idempotency test never looks at.
    expect(revenue.orders).toBe(1);
    expect(countIn(await ordersByStatusSince(prisma, since), OrderStatus.DELIVERED)).toBe(1);
    expect(bucketFor(await revenueByDay(prisma), settled.deliveredAt!).orders).toBe(1);

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 3. A partial refund ────────────────────────────────────────────────────

describe("scenario 3 — a partial refund on the day of the sale", () => {
  it("leaves the order DELIVERED, reduces Net Sales by exactly the payout, and reconciles clean", async () => {
    const since = todayWindowStart();
    const order = await makeSettledIdrOrder();
    const total = new Decimal(order.totalAmount);
    // Well under the total, so the order cannot reach REFUNDED.
    const paidBack = new Decimal("1.5");
    expect(paidBack.lessThan(total)).toBe(true);

    const execution = await payOutRefund({ orderId: order.id, amount: paidBack });

    // ── the order ──
    // A partial refund has no status edge of its own: the order stays sold.
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.DELIVERED);

    // ── the ledger ──
    const posting = await postingByKey(`refund_execution:${execution.id}`);
    expect(posting.type).toBe(FinancialTransactionType.REFUND);
    // Revenue WAS recognised for this order, so a refund reverses that much of
    // it — and a WALLET payout turns it into credit the shop still owes.
    expect(await entriesOf(posting.id)).toEqual([
      { code: "sales_revenue.idr", direction: "DEBIT", amount: paidBack.toString(), currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: paidBack.toString(), currency: "IDR" },
    ]);
    await expectBalancedPerCurrency(posting.id);
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(
      total.minus(paidBack).toString(),
    );
    // The money really moved: a COMPLETED payout next to an unchanged balance
    // would be a written claim that the buyer was paid.
    expect((await balances()).idr).toBe(paidBack.toString());

    // ── the dashboard ──
    // Revenue Today is a GROSS figure and a partial refund does not touch it
    // (the order never leaves DELIVERED) — metrics contract, "Revenue Today".
    expect((await revenueSummary(prisma, since)).revenue_idr.toString()).toBe(total.toString());
    expect((await grossSalesForNetSales(prisma, since)).idr.toString()).toBe(total.toString());
    expect((await refundTotalsSince(prisma, since)).refunds_idr.toString()).toBe(paidBack.toString());
    expect((await netSalesSince(since)).idr.toString()).toBe(total.minus(paidBack).toString());
    // On a partial-refund day the "Revenue = Net + Refunds" identity DOES hold,
    // because both figures count the sale exactly once. The full-refund
    // scenario below is where it correctly breaks.
    expect(total.toString()).toBe(total.minus(paidBack).plus(paidBack).toString());

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 4. A full refund, same day ─────────────────────────────────────────────

describe("scenario 4 — a full refund on the day of the sale (the Task 6b fix)", () => {
  it("moves the order to REFUNDED and nets the day to zero, not to minus the sale", async () => {
    const since = todayWindowStart();
    const order = await makeSettledIdrOrder();
    const total = new Decimal(order.totalAmount);

    const execution = await payOutRefund({ orderId: order.id, amount: total });

    // ── the order ──
    // A refund that brings the total refunded up to the order's own value
    // closes it. This is the premise of the whole bug: the sale now leaves
    // every DELIVERED-only figure.
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.REFUNDED);

    // ── the ledger ──
    const posting = await postingByKey(`refund_execution:${execution.id}`);
    await expectBalancedPerCurrency(posting.id);
    // All the revenue recognised for this order has been reversed. The books
    // net to zero revenue, which is the answer the dashboard must also reach.
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe("0");

    // ── the dashboard ──
    // Revenue Today drops to zero: the order is no longer DELIVERED. Correct
    // for a gross-delivered figure, and exactly why Net Sales needs its own
    // wider basis — metrics contract, "Why Net Sales uses its own gross basis".
    expect((await revenueSummary(prisma, since)).revenue_idr.toString()).toBe("0");
    expect((await revenueSummary(prisma, since)).orders).toBe(0);
    // ...while `grossSalesForNetSales` keeps counting it, so the payout is
    // subtracted exactly once.
    expect((await grossSalesForNetSales(prisma, since)).idr.toString()).toBe(total.toString());
    expect((await refundTotalsSince(prisma, since)).refunds_idr.toString()).toBe(total.toString());
    // Rp0 — as much was sold as was handed back. Before the Task 6b fix this
    // read minus the whole sale, a number that never happened.
    expect((await netSalesSince(since)).idr.toString()).toBe("0");
    // And the funnel moves it out of `delivered` without calling it failed.
    const funnel = await ordersByStatusSince(prisma, since);
    expect(countIn(funnel, OrderStatus.DELIVERED)).toBe(0);
    expect(countIn(funnel, OrderStatus.REFUNDED)).toBe(1);

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 5. A full refund on a later day ────────────────────────────────────────

describe("scenario 5 — a sale on one day, refunded in full on the next", () => {
  it("leaves the sale's own day's Net Sales intact and sends the refund day's negative", async () => {
    const order = await makeSettledIdrOrder();
    const total = new Decimal(order.totalAmount);

    // Back-date the settlement a full day. No production function can place a
    // settlement in the past, and the whole point of this scenario is that the
    // sale and the payout fall in different windows. `deliveredAt` is what
    // every revenue figure buckets on; `paidAt` moves with it so the order's
    // own two timestamps stay consistent.
    const soldAt = new Date(order.deliveredAt!.getTime() - 24 * 60 * 60_000);
    await prisma.order.update({
      where: { id: order.id },
      data: { deliveredAt: soldAt, paidAt: soldAt },
    });

    // The sale's own day, bounded so it cannot reach today.
    const saleDayStart = new Date(soldAt.getTime() - WINDOW_MINUTES * 60_000);
    const saleDayEnd = new Date(soldAt.getTime() + WINDOW_MINUTES * 60_000);
    // Today, bounded so it cannot reach back to the sale.
    const refundDayStart = todayWindowStart();

    // Before the refund, the sale's day reads as an ordinary sale.
    expect((await revenueSummary(prisma, saleDayStart, saleDayEnd)).revenue_idr.toString()).toBe(
      total.toString(),
    );

    const execution = await payOutRefund({ orderId: order.id, amount: total });
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.REFUNDED);
    // `executeRefund` stamps the payout with its own instant, which is today —
    // that is the day the money moved, and the day it is reported on.
    expect(execution.executedAt!.getTime()).toBeGreaterThan(refundDayStart.getTime());

    // ── the sale's own day is NOT retroactively reduced ──
    // `grossSalesForNetSales` still counts the (now REFUNDED) sale on its own
    // `deliveredAt`, and no payout landed that day, so Net Sales for the sale's
    // day is the full sale. A refund paid later never rewrites an earlier day's
    // net figure.
    expect((await grossSalesForNetSales(prisma, saleDayStart, saleDayEnd)).idr.toString()).toBe(
      total.toString(),
    );
    expect(
      (await refundTotalsSince(prisma, saleDayStart, saleDayEnd)).refunds_idr.toString(),
    ).toBe("0");
    const saleDayGross = await grossSalesForNetSales(prisma, saleDayStart, saleDayEnd);
    const saleDayRefunds = await refundTotalsSince(prisma, saleDayStart, saleDayEnd);
    expect(saleDayGross.idr.minus(saleDayRefunds.refunds_idr).toString()).toBe(total.toString());
    // The one figure that DOES change on the sale's day is "Revenue Today",
    // because it counts DELIVERED only and the order left that status. This is
    // documented behaviour, not a regression — metrics contract, "Revenue
    // Today" / "Excluded states". Pinned so nobody reads the assertion above
    // as a claim that a refund is invisible to gross revenue.
    expect((await revenueSummary(prisma, saleDayStart, saleDayEnd)).revenue_idr.toString()).toBe("0");

    // ── the refund's day goes negative, and is not clamped ──
    // Nothing was sold today and a whole order's value was handed back, so the
    // shop really did pay out more than it sold. Clamping that at zero would
    // hide the signal an operator most needs to see.
    expect((await revenueSummary(prisma, refundDayStart)).revenue_idr.toString()).toBe("0");
    expect((await grossSalesForNetSales(prisma, refundDayStart)).idr.toString()).toBe("0");
    expect((await refundTotalsSince(prisma, refundDayStart)).refunds_idr.toString()).toBe(
      total.toString(),
    );
    const refundDayNet = (await netSalesSince(refundDayStart)).idr;
    expect(refundDayNet.isNegative()).toBe(true);
    expect(refundDayNet.toString()).toBe(total.negated().toString());

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 6. Wallet deposit, then a purchase with that credit ────────────────────

describe("scenario 6 — a wallet top-up, then a product order paid with that credit", () => {
  it("books the top-up as a liability and only the sale as revenue, with no wallet drift at any step", async () => {
    const since = todayWindowStart();
    const topupAmount = new Decimal("20000");

    // ── step 1: the top-up settles ──
    const topup = await fundWalletByTopup(topupAmount);
    const topupPosting = await postingByKey(`order:${topup.id}:topup`);
    expect(topupPosting.type).toBe(FinancialTransactionType.WALLET_DEPOSIT);
    // Cash the gateway collected became credit the shop OWES. No revenue leg:
    // a top-up sells nothing.
    expect(await entriesOf(topupPosting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: topupAmount.toString(), currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: topupAmount.toString(), currency: "IDR" },
    ]);
    await expectBalancedPerCurrency(topupPosting.id);
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe("0");
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe(
      topupAmount.toString(),
    );
    expect((await balances()).idr).toBe(topupAmount.toString());

    // The headline fix of this whole milestone: a settled top-up is a real
    // DELIVERED order row, and no sales figure may count it.
    expect((await revenueSummary(prisma, since)).revenue_idr.toString()).toBe("0");
    expect((await revenueSummary(prisma, since)).orders).toBe(0);
    expect((await grossSalesForNetSales(prisma, since)).idr.toString()).toBe("0");
    expect(countIn(await ordersByStatusSince(prisma, since), OrderStatus.DELIVERED)).toBe(0);
    expect((await botOverallStats(prisma)).revenue_idr.toString()).toBe("0");
    expect((await shopFulfilmentStats(prisma)).deliveredOrders).toBe(0);
    expect((await shopFulfilmentStats(prisma)).customers).toBe(0);
    expect((await userTotalSpent(prisma, sample.user.id)).idr.toString()).toBe("0");
    await expectBooksReconcile();

    // ── step 2: the credit is spent at checkout, order not yet settled ──
    const walletSpend = new Decimal("2");
    const awaiting = await makeOrderAwaitingVerification({ walletAmount: walletSpend });
    expect(new Decimal(awaiting.walletUsed).toString()).toBe(walletSpend.toString());
    // The balance is already down; the ledger has heard nothing yet. That gap
    // is legitimate, and `inFlightWalletHolds` (Task 5's C1 fix) is what keeps
    // the drift check from firing on every ordinary wallet checkout.
    expect((await balances()).idr).toBe(topupAmount.minus(walletSpend).toString());
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe(
      topupAmount.toString(),
    );
    await expectBooksReconcile();

    // ── step 3: the order settles ──
    await approveOrder(prisma, awaiting.id, { adminId: ADMIN_ID });
    const order = (await getOrder(prisma, awaiting.id))!;
    expect(order.status).toBe(OrderStatus.DELIVERED);
    const gatewayLeg = new Decimal(order.totalAmount);

    const posting = await postingByKey(`order:${order.id}:payment`);
    // Two legs, both crediting revenue: credit spent at checkout earns the shop
    // the same revenue cash does, and spending it discharges the liability.
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: gatewayLeg.toString(), currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: gatewayLeg.toString(), currency: "IDR" },
      { code: "wallet_liability.idr", direction: "DEBIT", amount: walletSpend.toString(), currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: walletSpend.toString(), currency: "IDR" },
    ]);
    await expectBalancedPerCurrency(posting.id);
    // The liability has come down by exactly the credit spent, and now matches
    // the buyer's own balance again with no in-flight term needed.
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe(
      topupAmount.minus(walletSpend).toString(),
    );
    expect((await balances()).idr).toBe(topupAmount.minus(walletSpend).toString());
    // Exactly two postings across the whole story: the deposit and the sale.
    // The same rupiah is never recognised twice.
    const postings = await allPostings();
    expect(postings.map((p) => p.type)).toEqual([
      FinancialTransactionType.WALLET_DEPOSIT,
      FinancialTransactionType.ORDER_PAYMENT,
    ]);

    // ── the dashboard counts the sale, and only the sale ──
    const revenue = await revenueSummary(prisma, since);
    expect(revenue.orders).toBe(1);
    expect(countIn(await ordersByStatusSince(prisma, since), OrderStatus.DELIVERED)).toBe(1);
    expect((await shopFulfilmentStats(prisma)).deliveredOrders).toBe(1);

    // THE GAP THIS SCENARIO ONCE PINNED, NOW CLOSED (Financial Ledger M8.5).
    //
    // Every Order-rooted sales figure sums `Order.totalAmount`, which
    // `createOrderDirect` writes NET of `walletUsed` (orders.ts: `totalAmount =
    // afterDiscount - walletUsed + cents`) — it is only what the buyer owed
    // EXTERNALLY. The ledger has always recognised the whole sale
    // (`gatewayLeg + walletSpend`), so until M8.5 the wallet-paid portion of a
    // sale was revenue in the books and NOT revenue on the dashboard, and the
    // two views of one order disagreed by exactly `walletUsed`. An order paid
    // entirely from credit showed as zero revenue.
    //
    // `docs/sales-metrics-contract.md`'s Wallet Funding row says a top-up
    // "becomes revenue only when the credit is spent on a product order" — the
    // dashboard now honours that too, by adding the order's `order_payment`
    // wallet legs to the same figure (`walletSpendByCurrency`, crud/revenue.ts).
    // Asserted as the identity it is: the dashboard and the books agree on this
    // sale to the rupiah, and a regression in either direction fails here.
    expect(revenue.revenue_idr.toString()).toBe(gatewayLeg.plus(walletSpend).toString());
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(
      gatewayLeg.plus(walletSpend).toString(),
    );
    expect(
      (await getAccountBalance(prisma, "sales_revenue.idr")).minus(revenue.revenue_idr).toString(),
    ).toBe("0");

    // ── the drift detector, one last time ──
    await expectBooksReconcile();
  });
});

// ── 7 + 8. Currency separation: a USDT sale beside an IDR one ──────────────

describe("scenarios 7 and 8 — a USDT order and an IDR order, side by side", () => {
  it("keeps every ledger entry, revenue figure and refund figure in its own currency", async () => {
    const since = todayWindowStart();

    // The IDR baseline (scenario 8) and the USDT case (scenario 7) are asserted
    // together on purpose: currency separation is a claim about two figures not
    // contaminating each other, and it cannot be tested with only one currency
    // in the database.
    //
    // Both orders are for a realistically Rupiah-priced SKU, so the USDT total
    // lands around 10 USDT rather than rounding to zero — and the two figures
    // then differ by four orders of magnitude. That gap IS the test: a USDT
    // total summed into the Rupiah figure disappears into it unnoticed (the
    // historical "Rp3" display bug), while a Rupiah total leaking into the USDT
    // figure would swamp it. Either direction of contamination is visible here.
    const denom = await makeIdrPricedDenomination("160000");
    const idrOrder = await makeSettledIdrOrder({ productId: denom.id });
    const usdtOrder = await makeSettledUsdtOrder(denom.id);
    const idrTotal = new Decimal(idrOrder.totalAmount);
    const usdtTotal = new Decimal(usdtOrder.totalAmount);
    expect(idrTotal.greaterThan(100_000)).toBe(true);
    expect(usdtTotal.greaterThan(1)).toBe(true);
    expect(usdtTotal.lessThan(idrTotal.dividedBy(1000))).toBe(true);

    // ── the ledger: separate accounts, one currency each ──
    const idrPosting = await postingByKey(`order:${idrOrder.id}:payment`);
    expect(await entriesOf(idrPosting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: idrTotal.toString(), currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: idrTotal.toString(), currency: "IDR" },
    ]);
    const usdtPosting = await postingByKey(`order:${usdtOrder.id}:payment`);
    expect(await entriesOf(usdtPosting.id)).toEqual([
      { code: "provider_clearing.usdt", direction: "DEBIT", amount: usdtTotal.toString(), currency: "USDT" },
      { code: "sales_revenue.usdt", direction: "CREDIT", amount: usdtTotal.toString(), currency: "USDT" },
    ]);
    await expectBalancedPerCurrency(idrPosting.id);
    await expectBalancedPerCurrency(usdtPosting.id);
    // IDR and USDT are separate books: neither account holds the other's money.
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(idrTotal.toString());
    expect((await getAccountBalance(prisma, "sales_revenue.usdt")).toString()).toBe(usdtTotal.toString());

    // ── the dashboard: separate buckets ──
    const revenue = await revenueSummary(prisma, since);
    expect(revenue.revenue_idr.toString()).toBe(idrTotal.toString());
    expect(revenue.revenue_usdt.toString()).toBe(usdtTotal.toString());
    expect(revenue.orders).toBe(2);
    const day = bucketFor(await revenueByDay(prisma), idrOrder.deliveredAt!);
    expect(day.revenue_idr).toBe(idrTotal.toString());
    expect(day.revenue_usdt).toBe(usdtTotal.toString());
    expect(day.orders).toBe(2);

    // ── the one deliberate blend, and it uses the order's OWN fxRate ──
    // `currency=combined` is opt-in and converts through the per-order snapshot,
    // never a live rate, so a past day's total never moves under the reader.
    const combined = bucketFor(await combinedRevenueByDay(prisma), idrOrder.deliveredAt!);
    expect(combined.revenueIdrEquiv).toBe(
      idrTotal.plus(usdtTotal.times(USDT_RATE)).toString(),
    );

    // ── refunds stay in their own currency too ──
    const usdtRefund = usdtTotal.dividedBy(2).toDecimalPlaces(4);
    const idrRefund = new Decimal("1");
    await payOutRefund({ orderId: usdtOrder.id, amount: usdtRefund, currency: OrderCurrency.USDT });
    await payOutRefund({ orderId: idrOrder.id, amount: idrRefund, currency: OrderCurrency.IDR });

    const refunds = await refundTotalsSince(prisma, since);
    expect(refunds.refunds_idr.toString()).toBe(idrRefund.toString());
    expect(refunds.refunds_usdt.toString()).toBe(usdtRefund.toString());
    // Net Sales subtracts per currency and never cross-subtracts: the USDT
    // payout must not dent the Rupiah figure, and it is small enough that a
    // blended subtraction would round away unnoticed.
    const net = await netSalesSince(since);
    expect(net.idr.toString()).toBe(idrTotal.minus(idrRefund).toString());
    expect(net.usdt.toString()).toBe(usdtTotal.minus(usdtRefund).toString());
    // The buyer's USDT credit moved, their Rupiah credit did not.
    expect((await balances()).usdt).toBe(usdtRefund.toString());
    expect((await balances()).idr).toBe(idrRefund.toString());
    // ...and the same split holds in the books.
    expect((await getAccountBalance(prisma, "wallet_liability.usdt")).toString()).toBe(
      usdtRefund.toString(),
    );
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe(
      idrRefund.toString(),
    );
    // And a buyer's "Total Spent" is two numbers, never one blended scalar.
    const spent = await userTotalSpent(prisma, sample.user.id);
    expect(spent.idr.toString()).toBe(idrTotal.toString());
    expect(spent.usdt.toString()).toBe(usdtTotal.toString());

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 9. A rail that reports a fee ───────────────────────────────────────────

describe("scenario 9 — a TokoPay order, the only rail with any fee figure", () => {
  it("captures fee and net receipt as data and posts no FEE transaction anywhere", async () => {
    const since = todayWindowStart();
    const created = await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    });
    await prisma.order.update({
      where: { id: created!.id },
      data: { paymentMethod: PaymentMethod.TOKOPAY },
    });
    const order = (await getOrder(prisma, created!.id))!;
    const attempt = await createPaymentAttempt(prisma, {
      orderId: order.id,
      method: PaymentMethod.TOKOPAY,
      amount: order.totalAmount,
      currency: order.currency,
      reference: "TOKOPAY-INV-M8",
    });

    // The buyer pays the QRIS gross — the order total PLUS the surcharge.
    const grossPaid = qrisChargeAmount(order.totalAmount);
    expect(grossPaid.greaterThan(order.totalAmount)).toBe(true);
    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "trx-m8-fee",
      amount: grossPaid,
    });
    expect(result.status).toBe("delivered");

    // ── the fee figures, as data ──
    const confirmed = await prisma.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(confirmed.status).toBe(PaymentStatus.CONFIRMED);
    expect(confirmed.providerTransactionId).toBe("trx-m8-fee");
    expect(new Decimal(confirmed.fee!).toString()).toBe(
      computeQrisAdminFee(order.totalAmount).toString(),
    );
    // `netAmount` is the order total, NOT `amount - fee`: the surcharge rides on
    // top of what the buyer owed, so the total IS what the shop nets.
    expect(new Decimal(confirmed.netAmount!).toString()).toBe(
      new Decimal(order.totalAmount).toString(),
    );

    // ── and NO fee ledger event, anywhere ──
    // Task 3b's resolved scope decision: `computeQrisAdminFee` is a LOCAL
    // ESTIMATE (Rp100 + 0.70%) of what TokoPay will keep, not a cut TokoPay
    // reported deducting. The ORDER_PAYMENT posting already books the order
    // total, which is the shop's expected NET receipt, so a separate FEE
    // posting would either double-count money already netted out or invent a
    // financial event from an estimate. Re-asserted end-to-end here because
    // this decision has to survive everything M4-M7 built on top of it.
    const postings = await allPostings();
    expect(postings.map((p) => p.type)).toEqual([FinancialTransactionType.ORDER_PAYMENT]);
    expect(
      await prisma.financialTransaction.count({ where: { type: FinancialTransactionType.FEE } }),
    ).toBe(0);
    const feeAccounts = await prisma.ledgerAccount.findMany({
      where: { code: { startsWith: "payment_fee." } },
      select: { id: true },
    });
    // The accounts exist (the chart of accounts is seeded), so "no entries" is a
    // real fact about them rather than a vacuous truth about missing rows.
    expect(feeAccounts.length).toBeGreaterThan(0);
    expect(
      await prisma.ledgerEntry.count({ where: { accountId: { in: feeAccounts.map((a) => a.id) } } }),
    ).toBe(0);
    // The revenue posted is the order total, not the buyer's gross payment: the
    // surcharge never becomes this shop's asset at all.
    const total = new Decimal(order.totalAmount).toString();
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(total);
    expect((await getAccountBalance(prisma, "provider_clearing.idr")).toString()).toBe(total);

    // ── the dashboard sees the sale at its own value, not the gross charge ──
    expect((await revenueSummary(prisma, since)).revenue_idr.toString()).toBe(total);

    // ── the drift detector ──
    await expectBooksReconcile();
  });
});

// ── 10. A cancelled order that had spent wallet credit ─────────────────────

describe("scenario 10 — an order cancelled before it ever settled, with credit spent on it", () => {
  it("posts nothing, returns the hold, and leaves no wallet drift", async () => {
    const since = todayWindowStart();
    const topupAmount = new Decimal("20000");
    await fundWalletByTopup(topupAmount);

    // Wallet credit spent at checkout, then cancelled before payment. This
    // takes `cancelOrder`'s path (a PENDING_PAYMENT order with no proof
    // attached), which is a genuinely different route into `releaseOrderHolds`
    // than `reconcileLedger.test.ts`'s `rejectOrder` case — that one rejects
    // AFTER proof, from PENDING_VERIFICATION.
    const walletSpend = new Decimal("2");
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const created = await createOrderDirect(prisma, {
      user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
      productId: sample.product.id,
      quantity: 1,
      walletAmount: walletSpend,
    });
    const order = (await getOrder(prisma, created!.id))!;
    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(new Decimal(order.walletUsed).toString()).toBe(walletSpend.toString());

    await prisma.$transaction((tx) => cancelOrder(tx, order.id, "user_cancelled"));
    expect((await getOrder(prisma, order.id))!.status).toBe(OrderStatus.CANCELLED);

    // ── the ledger: nothing was recognised, and nothing was reversed ──
    // Task 3a's rule: this ledger recognises nothing until an order settles, so
    // there is no revenue to reverse and `postOrderHoldReleasePosting`
    // deliberately posts nothing. Inventing an entry here would credit
    // `wallet_liability` for an obligation the ledger never discharged.
    expect(
      await prisma.financialTransaction.findUnique({
        where: { idempotencyKey: `order:${order.id}:payment` },
      }),
    ).toBeNull();
    // Only the top-up's own deposit is in the books.
    const postings = await allPostings();
    expect(postings.map((p) => p.type)).toEqual([FinancialTransactionType.WALLET_DEPOSIT]);
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe("0");
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).toString()).toBe(
      topupAmount.toString(),
    );

    // ── the hold really came back, through a real movement row ──
    const released = await prisma.walletTransaction.findFirst({
      where: { orderId: order.id, reason: "order_refund" },
    });
    expect(released, "no order_refund movement row for the released hold").not.toBeNull();
    expect(new Decimal(released!.delta).toString()).toBe(walletSpend.toString());
    expect((await balances()).idr).toBe(topupAmount.toString());

    // ── the dashboard: a cancelled order is not a sale ──
    expect((await revenueSummary(prisma, since)).revenue_idr.toString()).toBe("0");
    expect((await revenueSummary(prisma, since)).orders).toBe(0);
    const funnel = await ordersByStatusSince(prisma, since);
    expect(countIn(funnel, OrderStatus.DELIVERED)).toBe(0);
    expect(countIn(funnel, OrderStatus.CANCELLED)).toBe(1);
    expect((await refundTotalsSince(prisma, since)).refunds_idr.toString()).toBe("0");
    expect((await netSalesSince(since)).idr.toString()).toBe("0");

    // ── the drift detector ──
    // The hold has stopped being in flight and the balance is whole again, so
    // counting it a second time would invent drift in the opposite direction.
    await expectBooksReconcile();
  });
});

// ── 11. A payment that expired before it settled ───────────────────────────

describe("scenario 11 — a payment attempt that expires before settlement", () => {
  it("leaves the books completely empty for that order and moves no dashboard figure", async () => {
    const since = todayWindowStart();
    // A settled order elsewhere in the same window, so "every figure is zero"
    // cannot pass just because nothing at all happened today.
    const goodOrder = await makeSettledIdrOrder();
    const goodTotal = new Decimal(goodOrder.totalAmount).toString();

    // A MANUAL SKU, so nothing can auto-deliver this one behind the test's back.
    const manual = await makeManualDenomination();
    const created = await createOrderDirect(prisma, {
      user: sample.user,
      productId: manual.id,
      quantity: 1,
    });
    const failing = (await getOrder(prisma, created!.id))!;
    const attempt = await createPaymentAttempt(prisma, {
      orderId: failing.id,
      method: PaymentMethod.TOKOPAY,
      amount: failing.totalAmount,
      currency: failing.currency,
      reference: "TOKOPAY-INV-M8-EXPIRED",
    });

    // The money never arrived: the attempt lapses and the order is cancelled.
    const expired = await expirePaymentAttempt(prisma, {
      paymentId: attempt.id,
      reason: "payment_window_elapsed",
      adminId: ADMIN_ID,
    });
    expect(expired.status).toBe(PaymentStatus.EXPIRED);
    await prisma.$transaction((tx) => cancelOrder(tx, failing.id, "expired"));
    expect((await getOrder(prisma, failing.id))!.status).toBe(OrderStatus.CANCELLED);

    // ── the ledger has no record of it at all ──
    expect(
      await prisma.financialTransaction.count({
        where: { referenceType: "order", referenceId: failing.id },
      }),
    ).toBe(0);
    // The only posting in the books belongs to the order that really was paid.
    const postings = await allPostings();
    expect(postings).toHaveLength(1);
    expect(postings[0]!.idempotencyKey).toBe(`order:${goodOrder.id}:payment`);
    expect((await getAccountBalance(prisma, "sales_revenue.idr")).toString()).toBe(goodTotal);

    // ── no dashboard figure moved ──
    const revenue = await revenueSummary(prisma, since);
    expect(revenue.revenue_idr.toString()).toBe(goodTotal);
    expect(revenue.orders).toBe(1);
    expect((await grossSalesForNetSales(prisma, since)).idr.toString()).toBe(goodTotal);
    expect((await refundTotalsSince(prisma, since)).refunds_idr.toString()).toBe("0");
    expect((await netSalesSince(since)).idr.toString()).toBe(goodTotal);
    const funnel = await ordersByStatusSince(prisma, since);
    expect(countIn(funnel, OrderStatus.DELIVERED)).toBe(1);
    expect(countIn(funnel, OrderStatus.CANCELLED)).toBe(1);
    expect(bucketFor(await revenueByDay(prisma), goodOrder.deliveredAt!).orders).toBe(1);
    expect((await shopFulfilmentStats(prisma)).deliveredOrders).toBe(1);

    // ── the drift detector ──
    // A failed payment is not missing-posting drift: nothing was ever settled,
    // so there is nothing the books should have recorded.
    await expectBooksReconcile();
  });
});
