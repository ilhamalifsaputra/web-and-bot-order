/**
 * Ledger postings (Financial Ledger M3) — the first real callers of
 * `postFinancialTransaction`, exercised end-to-end through the order, top-up,
 * adjustment and refund paths that raise them.
 *
 * These tests are deliberately driven through the BUSINESS functions
 * (`approveOrder`, `settlePaidOrder`, `settleWalletTopup`,
 * `creditOrderToBalance`, `rejectOrder`, `maybePayReferralCommission`,
 * `refundUnderpaidOrder`) rather than by calling the posting helpers directly
 * wherever that is possible. A posting helper that is correct in isolation but
 * wired to the wrong place — or wired twice, or not at all — produces exactly
 * the same silent misstatement as a wrong debit/credit direction, and only a
 * test that starts where the real money movement starts can catch it.
 *
 * Three properties get assertions in every case, because each fails silently:
 *
 * 1. **Direction.** Which account is debited decides the SIGN of every number a
 *    future report shows. `Dr sales_revenue` where `Dr provider_clearing` was
 *    meant leaves the trial balance perfectly balanced and the revenue figure
 *    wrong, which is the one error class a balance check cannot find.
 * 2. **Idempotency.** Every payment rail here is at-least-once, and an admin can
 *    double-tap any button. A second posting for one event double-counts real
 *    money.
 * 3. **Balance per currency.** Asserted by `expectBalanced` on every posting, not
 *    just the mixed-currency ones, so a leg added later to any of these postings
 *    cannot land unpaired.
 *
 * The conditional rule (`hasPostedOrderPayment`) gets both of its branches
 * exercised for both reasons that use it, and the "post nothing" branch gets a
 * negative assertion — a rule whose silent path is untested is a rule that will
 * eventually post on it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@app/core/money";
import {
  DeliveryType,
  FinancialTransactionType,
  LedgerDirection,
  OrderStatus,
  PaymentMethod,
} from "@app/core/enums";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  adjustWallet,
  approveOrder,
  attachPaymentProof,
  cancelOrder,
  createCatalogProduct,
  createCategory,
  createDenomination,
  createOrderDirect,
  createWalletTopupOrder,
  creditOrderToBalance,
  creditUnderpaidTopupAnyway,
  getOrder,
  markOrderUnderpaid,
  markUnderpaid,
  maybePayReferralCommission,
  postFinancialTransaction,
  postOrderPaymentPosting,
  postWalletAdjustmentPosting,
  postWalletTopupPosting,
  seedChartOfAccounts,
  refundUnderpaidOrder,
  rejectOrder,
  settlePaidOrder,
  settleWalletTopup,
  upsertUser,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

/** A fixed admin id for every acting-admin argument below. */
const ADMIN_ID = 7;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  // `resetDb` clears the ledger's postings and seeds the chart of accounts (it
  // has to: every settlement path below posts to it now) — see its own comment.
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
});

// ── Assertion helpers ──────────────────────────────────────────────────────

/** One posting's entries, flattened into a readable, order-independent shape. */
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
  expect(posting, `no posting found under idempotency key "${idempotencyKey}"`).not.toBeNull();
  return posting!;
}

/**
 * Debits equal credits within every currency of one posting.
 *
 * Re-asserted here rather than trusted from `postFinancialTransaction`'s own
 * tests, because what is being tested in this file is the ENTRY LISTS the
 * posting map builds: the service rejects an unbalanced list, so an unbalanced
 * list shows up as a thrown settlement, and a settlement that throws in a place
 * these tests don't happen to assert on would otherwise pass unnoticed.
 */
async function expectBalanced(financialTransactionId: number) {
  const rows = await entriesOf(financialTransactionId);
  const sums = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const row of rows) {
    const sum = sums.get(row.currency) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    if (row.direction === LedgerDirection.DEBIT) sum.debit = sum.debit.plus(row.amount);
    else sum.credit = sum.credit.plus(row.amount);
    sums.set(row.currency, sum);
  }
  expect(sums.size, "a posting with no entries is not a posting").toBeGreaterThan(0);
  for (const [currency, sum] of sums) {
    expect(sum.debit.toString(), `debits != credits in ${currency}`).toBe(sum.credit.toString());
  }
}

/** Every posting currently in the books, newest last. */
const allPostings = () => prisma.financialTransaction.findMany({ orderBy: { id: "asc" } });

// ── Fixture builders ───────────────────────────────────────────────────────

/** A manual-delivery SKU, so `settlePaidOrder` takes its MANUAL branch. */
async function makeManualDenomination(price = "10.00") {
  const category = await createCategory(prisma, `manual-${Math.random()}`);
  const parent = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Product ${Math.random()}`,
  });
  return createDenomination(prisma, {
    productId: parent.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price,
    warrantyDays: 30,
    deliveryType: DeliveryType.MANUAL,
  });
}

/**
 * An order sitting at PENDING_VERIFICATION — the state both `approveOrder` and
 * `settlePaidOrder` accept — built through the same
 * createOrderDirect → attachPaymentProof path a real buyer walks.
 */
async function makeOrderAwaitingVerification(args: {
  productId: number;
  walletAmount?: Decimal.Value;
}) {
  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const order = await createOrderDirect(prisma, {
    // `createOrderDirect` checks the affordability of `walletAmount` against the
    // balance it is HANDED, not against the row — so it has to be passed in.
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: args.productId,
    quantity: 1,
    walletAmount: args.walletAmount,
  });
  await attachPaymentProof(prisma, order!.id, { fileId: "proof", txid: `TX-${order!.id}` });
  return (await getOrder(prisma, order!.id))!;
}

/** Give the sample buyer spendable IDR credit, without leaving a posting behind. */
async function fundIdrWallet(amount: Decimal.Value) {
  await adjustWallet(prisma, sample.user.id, amount, { reason: "admin_adjust", currency: "IDR" });
  // Funding is a real money event, but it is fixture setup here — and it posts
  // nothing anyway (only the `admin_adjust` call sites post, and this is not one
  // of them). Clear the ledger regardless so each test's assertions
  // start from empty books even if that changes.
  await prisma.ledgerEntry.deleteMany();
  await prisma.financialTransaction.deleteMany();
}

// ── 1. Order payment ───────────────────────────────────────────────────────

describe("order payment posting (approveOrder / settlePaidOrder)", () => {
  it("posts Dr provider_clearing / Cr sales_revenue for a gateway-paid order", async () => {
    const order = await makeOrderAwaitingVerification({ productId: sample.product.id });

    await approveOrder(prisma, order.id, { adminId: ADMIN_ID });

    const posting = await postingByKey(`order:${order.id}:payment`);
    expect(posting.type).toBe(FinancialTransactionType.ORDER_PAYMENT);
    expect(posting.referenceType).toBe("order");
    expect(posting.referenceId).toBe(order.id);
    // occurredAt is the order's real payment time, not a second clock read.
    const settled = (await getOrder(prisma, order.id))!;
    expect(posting.occurredAt.getTime()).toBe(settled.paidAt!.getTime());

    const total = new Decimal(order.totalAmount).toString();
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: total, currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: total, currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
  });

  it("adds a wallet leg from the order_payment ledger rows, in the currency they carry", async () => {
    await fundIdrWallet("3.00");
    const order = await makeOrderAwaitingVerification({
      productId: sample.product.id,
      walletAmount: "2.00", // of a 5.00 order → 3.00 left for the gateway
    });
    expect(new Decimal(order.walletUsed).toString()).toBe("2");

    await approveOrder(prisma, order.id, { adminId: ADMIN_ID });

    const posting = await postingByKey(`order:${order.id}:payment`);
    const entries = await entriesOf(posting.id);
    const gatewayTotal = new Decimal(order.totalAmount).toString();
    // Both legs credit revenue: credit spent at checkout earns the shop the same
    // revenue cash does, and spending it discharges the wallet liability.
    expect(entries).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: gatewayTotal, currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: gatewayTotal, currency: "IDR" },
      { code: "wallet_liability.idr", direction: "DEBIT", amount: "2", currency: "IDR" },
      { code: "sales_revenue.idr", direction: "CREDIT", amount: "2", currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
    // Revenue recognised is the whole order, however the buyer split the payment.
    const revenue = entries
      .filter((e) => e.code === "sales_revenue.idr")
      .reduce((sum, e) => sum.plus(e.amount), new Decimal(0));
    expect(revenue.toString()).toBe(new Decimal(order.totalAmount).plus(2).toString());
  });

  it("posts once for a manually-fulfilled order, from settlePaidOrder's MANUAL branch", async () => {
    const manual = await makeManualDenomination();
    const order = await makeOrderAwaitingVerification({ productId: manual.id });

    const result = await settlePaidOrder(prisma, order.id, { adminId: ADMIN_ID });
    expect(result.kind).toBe("processing"); // the MANUAL branch, not approveOrder's

    const posting = await postingByKey(`order:${order.id}:payment`);
    expect(await entriesOf(posting.id)).toEqual([
      {
        code: "provider_clearing.idr",
        direction: "DEBIT",
        amount: new Decimal(order.totalAmount).toString(),
        currency: "IDR",
      },
      {
        code: "sales_revenue.idr",
        direction: "CREDIT",
        amount: new Decimal(order.totalAmount).toString(),
        currency: "IDR",
      },
    ]);
    expect(await allPostings()).toHaveLength(1);
  });

  it("recognises revenue exactly once when a settlement is replayed", async () => {
    const order = await makeOrderAwaitingVerification({ productId: sample.product.id });
    await approveOrder(prisma, order.id, { adminId: ADMIN_ID });
    const first = await postingByKey(`order:${order.id}:payment`);

    // A redelivered gateway webhook re-drives settlement. approveOrder's atomic
    // claim refuses the second attempt, which is the behaviour being relied on —
    // and the ledger must be unchanged either way.
    await expect(approveOrder(prisma, order.id, { adminId: ADMIN_ID })).rejects.toThrow();

    // That assertion alone only proves the CALLER refused the retry: approveOrder
    // threw before it ever reached the posting a second time. The ledger's own
    // `order:{id}:payment` key has to dedupe too, because it is the last line of
    // defence for a caller that DOESN'T short-circuit — so drive the posting
    // directly and require the first row back rather than a second one.
    const reposted = await postOrderPaymentPosting(prisma, order, first.occurredAt);
    expect(reposted!.id).toBe(first.id);

    const postings = await allPostings();
    expect(postings).toHaveLength(1);
    expect(postings[0]!.id).toBe(first.id);
    expect(await prisma.ledgerEntry.count()).toBe(2);
  });

  it("posts nothing, and does not throw, for an order with no chargeable amount", async () => {
    // No external total and no wallet spend — the state the guard exists for. A
    // pricing or voucher rule reducing an order to nothing is the realistic way
    // there; forced directly here because no current rule can reach exactly zero.
    const order = await makeOrderAwaitingVerification({ productId: sample.product.id });
    await prisma.order.update({ where: { id: order.id }, data: { totalAmount: 0 } });

    // Delivery must still succeed: a bookkeeping gap may never strand a buyer.
    await expect(approveOrder(prisma, order.id, { adminId: ADMIN_ID })).resolves.toMatchObject({
      order: { status: OrderStatus.DELIVERED },
    });
    expect(await allPostings()).toEqual([]);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });
});

// ── 1b. An unseeded chart of accounts must not break settlement ────────────

describe("an unseeded chart of accounts", () => {
  it("skips the posting and still delivers a paid order", async () => {
    // The shape of a deploy where `pnpm seed-chart-of-accounts` was never run.
    // Failing settlement here would mean a shop refusing to deliver orders whose
    // money has already arrived, over a missing bookkeeping row — the money is
    // recoverable from the wallet/order tables, an undelivered paid order is not.
    const order = await makeOrderAwaitingVerification({ productId: sample.product.id });
    await prisma.ledgerEntry.deleteMany();
    await prisma.financialTransaction.deleteMany();
    await prisma.ledgerAccount.deleteMany();

    await expect(approveOrder(prisma, order.id, { adminId: ADMIN_ID })).resolves.toMatchObject({
      order: { status: OrderStatus.DELIVERED },
    });
    expect(await allPostings()).toEqual([]);

    // Re-seed for the tests that follow — `resetDb` only seeds when the table is
    // empty, and it runs before each test, so leaving it empty here is fine; this
    // is belt-and-braces against a future change to that ordering.
    await seedChartOfAccounts(prisma);
  });

  it("still surfaces a genuinely unbalanced posting as an error", async () => {
    // The contrast that makes the skip above safe: a missing account is an
    // operator omission and is skipped, but an entry list whose debits and
    // credits disagree means the posting code itself is wrong, and that must
    // never be silently dropped.
    await expect(
      postFinancialTransaction(prisma, {
        type: FinancialTransactionType.ORDER_PAYMENT,
        referenceType: "order",
        referenceId: 1,
        idempotencyKey: "unbalanced-probe",
        description: "Deliberately unbalanced, to prove this still throws.",
        occurredAt: new Date(),
        entries: [
          {
            accountCode: "provider_clearing.idr",
            direction: LedgerDirection.DEBIT,
            amount: "100",
            currency: "IDR",
          },
          {
            accountCode: "sales_revenue.idr",
            direction: LedgerDirection.CREDIT,
            amount: "90",
            currency: "IDR",
          },
        ],
      }),
    ).rejects.toMatchObject({ key: "error.ledger_unbalanced" });
  });
});

// ── 2. Wallet top-up ───────────────────────────────────────────────────────

describe("wallet top-up posting (settleWalletTopup)", () => {
  /** A PENDING_PAYMENT IDR top-up order for `amount`, on a real IDR rail. */
  async function makeTopup(amount: string) {
    return createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount,
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
  }

  it("posts Dr provider_clearing / Cr wallet_liability — never revenue", async () => {
    const topup = await makeTopup("150000");

    await settleWalletTopup(prisma, topup.id, { amount: "150000" });

    const posting = await postingByKey(`order:${topup.id}:topup`);
    expect(posting.type).toBe(FinancialTransactionType.WALLET_DEPOSIT);
    expect(posting.referenceType).toBe("order");
    expect(posting.referenceId).toBe(topup.id);

    const entries = await entriesOf(posting.id);
    expect(entries).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: "150000", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "150000", currency: "IDR" },
    ]);
    // The whole point of this posting's shape: a top-up sells nothing, so no
    // revenue may be recognised until the credit is spent on an order.
    expect(entries.some((e) => e.code.startsWith("sales_revenue"))).toBe(false);
    await expectBalanced(posting.id);
  });

  it("credits the buyer and posts to the books exactly once on a replayed settlement", async () => {
    const topup = await makeTopup("100000");

    await settleWalletTopup(prisma, topup.id, { amount: "100000" });
    // Second delivery of the same webhook: the atomic claim makes this a no-op.
    const replay = await settleWalletTopup(prisma, topup.id, { amount: "100000" });
    expect(new Decimal(replay.credited).toString()).toBe("0");

    // As with the order-payment replay above, that no-op is `settleWalletTopup`'s
    // own lost-claim branch returning early — it never reaches the posting again.
    // `order:{id}:topup` must dedupe on its own account, so post it directly a
    // second time and require the first row back.
    const first = await postingByKey(`order:${topup.id}:topup`);
    const reposted = await postWalletTopupPosting(prisma, topup, first.occurredAt);
    expect(reposted!.id).toBe(first.id);

    expect(await allPostings()).toHaveLength(1);
    expect(await prisma.ledgerEntry.count()).toBe(2);
  });
});

// ── 2b. An underpaid top-up credited anyway ────────────────────────────────

describe("underpaid wallet top-up credited anyway (creditUnderpaidTopupAnyway)", () => {
  it("posts Dr provider_clearing / Cr wallet_liability for the amount that really arrived", async () => {
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "20000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    // Driven through the real gateway path that flags a shortfall, because that
    // is what writes the row `findUnderpaidReceived` reads: without it this
    // resolution credits nothing and there is no posting to assert on.
    expect(
      await markOrderUnderpaid(prisma, {
        orderId: topup.id,
        gateway: "TokoPay",
        receivedAmount: "18500",
        expectedAmount: topup.totalAmount,
      }),
    ).toBe(true);

    const { credited } = await creditUnderpaidTopupAnyway(prisma, {
      orderId: topup.id,
      adminId: ADMIN_ID,
    });
    expect(credited.toString()).toBe("18500");

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: topup.id, reason: "admin_adjust" },
    });
    const posting = await postingByKey(`wallet:${movement.id}`);
    expect(posting.type).toBe(FinancialTransactionType.ADJUSTMENT);
    // The top-up order is the back-pointer, not the acting admin: what this
    // posting claims is that a rail collected 18500 against THIS order, which is
    // the figure M5's reconciliation has to tie back to a gateway payment.
    expect(posting.referenceType).toBe("order");
    expect(posting.referenceId).toBe(topup.id);

    const entries = await entriesOf(posting.id);
    // Real gateway cash, recognised for the first time — the same shape as an
    // underpaid product order's credit. NOT `Dr adjustment.idr`: that would fund
    // the buyer's new balance out of the shop's own equity and leave the money
    // the rail actually collected unrecorded on the asset side, which balances
    // and is still wrong.
    expect(entries).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: "18500", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "18500", currency: "IDR" },
    ]);
    expect(entries.some((e) => e.code.startsWith("adjustment"))).toBe(false);
    await expectBalanced(posting.id);
    // The top-up itself never settled, so there is no WALLET_DEPOSIT posting
    // beside this one — the shortfall was never credited as a full top-up.
    expect(await allPostings()).toHaveLength(1);
  });

  it("uses the USDT accounts when the underpaid rail was a USDT one", async () => {
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "10",
      currency: "USDT",
      method: PaymentMethod.BINANCE_INTERNAL,
      rate: "16000",
    });
    expect(
      await markUnderpaid(prisma, {
        orderId: topup.id,
        binanceTxId: `bin-ledger-underpaid-${topup.id}`,
        amount: "6.5",
      }),
    ).toBe(true);

    await creditUnderpaidTopupAnyway(prisma, { orderId: topup.id, adminId: ADMIN_ID });

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: topup.id, reason: "admin_adjust" },
    });
    const posting = await postingByKey(`wallet:${movement.id}`);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.usdt", direction: "DEBIT", amount: "6.5", currency: "USDT" },
      { code: "wallet_liability.usdt", direction: "CREDIT", amount: "6.5", currency: "USDT" },
    ]);
    await expectBalanced(posting.id);
  });

  it("posts nothing when no rail recorded how much arrived", async () => {
    // An order somebody moved to UNDERPAID by hand: it is still cancelled, but no
    // wallet movement is written, so there is no money event to post either.
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "20000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    await prisma.order.update({
      where: { id: topup.id },
      data: { status: OrderStatus.UNDERPAID },
    });

    const { credited } = await creditUnderpaidTopupAnyway(prisma, {
      orderId: topup.id,
      adminId: ADMIN_ID,
    });

    expect(credited.toString()).toBe("0");
    expect(await allPostings()).toEqual([]);
    expect(await prisma.ledgerEntry.count()).toBe(0);
  });
});

// ── 3. Manual wallet adjustment ────────────────────────────────────────────

describe("manual wallet adjustment posting (admin_adjust)", () => {
  /** Move the buyer's balance by hand, the way all three call sites do. */
  async function adjustByHand(delta: string, currency: "IDR" | "USDT" = "IDR") {
    return prisma.$transaction(async (tx) => {
      const { transactionId } = await adjustWallet(tx, sample.user.id, delta, {
        reason: "admin_adjust",
        adminId: ADMIN_ID,
        currency,
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

  it("posts Dr adjustment / Cr wallet_liability when an admin credits a buyer", async () => {
    const transactionId = await adjustByHand("25000");

    const posting = await postingByKey(`wallet:${transactionId}`);
    expect(posting.type).toBe(FinancialTransactionType.ADJUSTMENT);
    // A hand-made move's most useful back-pointer is the admin who made it.
    expect(posting.referenceType).toBe("manual");
    expect(posting.referenceId).toBe(ADMIN_ID);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "adjustment.idr", direction: "DEBIT", amount: "25000", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "25000", currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
  });

  it("swaps the legs when an admin debits a buyer, keeping the amount positive", async () => {
    await fundIdrWallet("40000");

    const transactionId = await adjustByHand("-15000");

    const posting = await postingByKey(`wallet:${transactionId}`);
    // Direction carries the sign; `amount` is always a magnitude (LedgerEntry's
    // invariant), so a negative delta must appear as swapped legs, never as -15000.
    expect(await entriesOf(posting.id)).toEqual([
      { code: "wallet_liability.idr", direction: "DEBIT", amount: "15000", currency: "IDR" },
      { code: "adjustment.idr", direction: "CREDIT", amount: "15000", currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
  });

  it("uses the USDT accounts for a USDT adjustment", async () => {
    const transactionId = await adjustByHand("12.5", "USDT");

    const posting = await postingByKey(`wallet:${transactionId}`);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "adjustment.usdt", direction: "DEBIT", amount: "12.5", currency: "USDT" },
      { code: "wallet_liability.usdt", direction: "CREDIT", amount: "12.5", currency: "USDT" },
    ]);
  });

  it("posts nothing for a zero-value adjustment instead of throwing", async () => {
    // Entry amounts must be strictly positive, so a movement that applied
    // nothing has no posting to make — and must not break the admin's action.
    const transactionId = await adjustByHand("0");

    expect(await allPostings()).toEqual([]);
    expect(
      await prisma.financialTransaction.findUnique({
        where: { idempotencyKey: `wallet:${transactionId}` },
      }),
    ).toBeNull();
  });

  it("is idempotent on the wallet movement's id", async () => {
    const transactionId = await adjustByHand("5000");

    // A retried posting for the same movement (a re-run, a double-tap that
    // reached the posting twice) returns the first one.
    await postWalletAdjustmentPosting(prisma, {
      walletTransactionId: transactionId,
      adminId: ADMIN_ID,
      occurredAt: new Date(),
    });

    expect(await allPostings()).toHaveLength(1);
    expect(await prisma.ledgerEntry.count()).toBe(2);
  });
});

// ── 4. Referral commission ─────────────────────────────────────────────────

describe("referral commission posting", () => {
  it("posts Dr referral_expense.usdt / Cr wallet_liability.usdt", async () => {
    const referrer = await upsertUser(prisma, {
      telegramId: 9001,
      username: "referrer",
      fullName: "Referrer",
    });
    const referee = await upsertUser(prisma, {
      telegramId: 9002,
      username: "referee",
      fullName: "Referee",
    });
    await prisma.user.update({ where: { id: referee.id }, data: { referredById: referrer.id } });

    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-REF-1",
        userId: referee.id,
        status: OrderStatus.DELIVERED,
        totalAmount: "100",
        subtotalAmount: "100",
        currency: "USDT",
      },
    });
    const occurredAt = new Date("2026-09-01T10:00:00.000Z");

    await maybePayReferralCommission(
      prisma,
      {
        id: order.id,
        userId: referee.id,
        orderCode: order.orderCode,
        totalAmount: order.totalAmount,
        currency: "USDT",
      },
      occurredAt,
    );

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { reason: "referral", orderId: order.id },
    });
    const commission = new Decimal(movement.delta).toString();
    expect(new Decimal(commission).greaterThan(0)).toBe(true);

    const posting = await postingByKey(`wallet:${movement.id}`);
    expect(posting.type).toBe(FinancialTransactionType.ADJUSTMENT);
    expect(posting.referenceType).toBe("order");
    expect(posting.referenceId).toBe(order.id);
    // The caller's delivery timestamp, not a clock read inside the posting.
    expect(posting.occurredAt.getTime()).toBe(occurredAt.getTime());
    // An expense, not a second liability: wallet_liability already carries the
    // obligation created by the very same credit.
    expect(await entriesOf(posting.id)).toEqual([
      { code: "referral_expense.usdt", direction: "DEBIT", amount: commission, currency: "USDT" },
      { code: "wallet_liability.usdt", direction: "CREDIT", amount: commission, currency: "USDT" },
    ]);
    await expectBalanced(posting.id);
  });
});

// ── 5. The conditional rule: money flowing back toward the customer ────────

describe("wallet credit against an order — the prior-ORDER_PAYMENT rule", () => {
  it("debits provider_clearing when the order never settled (no prior ORDER_PAYMENT)", async () => {
    // PENDING_VERIFICATION: paidAt is null and no ORDER_PAYMENT was ever posted,
    // so the buyer's payment is being recognised here for the FIRST time.
    const order = await makeOrderAwaitingVerification({ productId: sample.product.id });
    expect(order.paidAt).toBeNull();

    const credited = await creditOrderToBalance(prisma, { orderId: order.id, adminId: ADMIN_ID });

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    const posting = await postingByKey(`wallet:${movement.id}`);
    expect(posting.type).toBe(FinancialTransactionType.REFUND);
    const amount = new Decimal(credited.credited).toString();
    // Not Dr sales_revenue: no revenue was ever recognised for this order, so
    // debiting it would book negative revenue that was never earned AND leave
    // the cash that really arrived unrecorded on the asset side.
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount, currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount, currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
  });

  it("debits sales_revenue when the order already settled (prior ORDER_PAYMENT exists)", async () => {
    // A manual SKU settled through settlePaidOrder's MANUAL branch is PROCESSING
    // with an ORDER_PAYMENT already posted — and `canCredit` covers PROCESSING.
    const manual = await makeManualDenomination();
    const order = await makeOrderAwaitingVerification({ productId: manual.id });
    await settlePaidOrder(prisma, order.id, { adminId: ADMIN_ID });
    const paymentPosting = await postingByKey(`order:${order.id}:payment`);

    const credited = await creditOrderToBalance(prisma, { orderId: order.id, adminId: ADMIN_ID });

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    const posting = await postingByKey(`wallet:${movement.id}`);
    const amount = new Decimal(credited.credited).toString();
    expect(await entriesOf(posting.id)).toEqual([
      { code: "sales_revenue.idr", direction: "DEBIT", amount, currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount, currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
    // The reversal is a separate posting, not an edit of the original: this
    // ledger is append-only.
    expect(posting.id).not.toBe(paymentPosting.id);
  });

  it("recognises an underpaid crypto deposit against provider_clearing, not revenue", async () => {
    const order = await makeOrderAwaitingVerification({ productId: sample.product.id });
    // The UNDERPAID state refundUnderpaidOrder requires, plus the rail's own
    // record of how much actually arrived — `findUnderpaidReceived` reads that
    // row, and without it the refund credits nothing.
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.UNDERPAID },
    });
    await prisma.processedBinanceTx.create({
      data: {
        binanceTxId: `UNDERPAID-${order.id}`,
        orderId: order.id,
        outcome: "underpaid",
        amount: "2.0000",
      },
    });

    const result = await refundUnderpaidOrder(prisma, { orderId: order.id, adminId: ADMIN_ID });
    expect(new Decimal(result.refunded).toString()).toBe("2");

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "underpaid_refund" },
    });
    const posting = await postingByKey(`wallet:${movement.id}`);
    expect(posting.type).toBe(FinancialTransactionType.REFUND);
    // An UNDERPAID order never has paidAt set, so no ORDER_PAYMENT exists and
    // there is no revenue to reverse — only cash to recognise for the first time.
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: "DEBIT", amount: "2", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "2", currency: "IDR" },
    ]);
    await expectBalanced(posting.id);
  });
});

// ── 6. The conditional rule: releasing a checkout wallet hold ──────────────

describe("wallet hold release — posts only when revenue was recognised", () => {
  it("posts nothing when an unpaid order with a wallet hold is rejected", async () => {
    await fundIdrWallet("10.00");
    const order = await makeOrderAwaitingVerification({
      productId: sample.product.id,
      walletAmount: "2.00",
    });
    expect(new Decimal(order.walletUsed).greaterThan(0)).toBe(true);

    await rejectOrder(prisma, order.id, { adminId: ADMIN_ID, reason: "proof was not valid" });

    // The checkout debit was never posted (nothing is recognised until settle),
    // so releasing it is an internal reversal of an unrecorded event. Posting
    // here would inflate wallet_liability above the sum of real wallet balances
    // forever — balanced books, wrong numbers.
    expect(await allPostings()).toEqual([]);
    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "order_refund" },
    });
    expect(new Decimal(movement.delta).toString()).toBe("2"); // the buyer WAS refunded
  });

  it("posts nothing when an unpaid order with a wallet hold is cancelled", async () => {
    await fundIdrWallet("10.00");
    const order = await makeOrderAwaitingVerification({
      productId: sample.product.id,
      walletAmount: "2.00",
    });

    await cancelOrder(prisma, order.id, "admin_cancelled");

    expect(await allPostings()).toEqual([]);
  });

  it("reverses the wallet-paid revenue when a settled order is credited back", async () => {
    await fundIdrWallet("10.00");
    const manual = await makeManualDenomination();
    const order = await makeOrderAwaitingVerification({
      productId: manual.id,
      walletAmount: "2.00",
    });
    // Settle it: ORDER_PAYMENT now recognises BOTH the gateway leg and the
    // 2.00 wallet leg as revenue.
    await settlePaidOrder(prisma, order.id, { adminId: ADMIN_ID });
    const payment = await postingByKey(`order:${order.id}:payment`);
    const paymentEntries = await entriesOf(payment.id);
    expect(paymentEntries).toContainEqual({
      code: "wallet_liability.idr",
      direction: "DEBIT",
      amount: "2",
      currency: "IDR",
    });

    // Now the shop cannot fulfil it, so the admin credits it back. This releases
    // the wallet hold too — and that release MUST reverse the revenue the wallet
    // leg above recognised, or sales_revenue stays overstated by 2.00 forever.
    await creditOrderToBalance(prisma, { orderId: order.id, adminId: ADMIN_ID });

    const release = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "order_refund" },
    });
    const posting = await postingByKey(`wallet:${release.id}`);
    expect(posting.type).toBe(FinancialTransactionType.REFUND);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "sales_revenue.idr", direction: "DEBIT", amount: "2", currency: "IDR" },
      { code: "wallet_liability.idr", direction: "CREDIT", amount: "2", currency: "IDR" },
    ]);
    await expectBalanced(posting.id);

    // Three postings, each its own event: the payment, the external-payment
    // credit, and this hold release. And the wallet leg nets to zero, which is
    // the invariant M5's reconciliation checks.
    expect(await allPostings()).toHaveLength(3);
    const walletLegs = await prisma.ledgerEntry.findMany({
      where: { account: { code: "wallet_liability.idr" } },
    });
    const net = walletLegs.reduce(
      (sum, leg) =>
        leg.direction === LedgerDirection.DEBIT
          ? sum.minus(leg.amount.toString())
          : sum.plus(leg.amount.toString()),
      new Decimal(0),
    );
    // Debited 2.00 at settlement, credited 2.00 back on release, plus the
    // credited order total — the buyer's balance rose by exactly that total.
    const credit = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "unfulfilled_credit" },
    });
    expect(net.toString()).toBe(new Decimal(credit.delta).toString());
  });
});
