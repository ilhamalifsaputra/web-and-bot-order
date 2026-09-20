/**
 * Overpayment credits (task F2) — the caller `postOverpaymentCreditPosting`
 * shipped without (decision D3).
 *
 * Two things are being tested, and the first one is the reason this file exists:
 *
 * 1. **The excess is DERIVED from the rail's own record, never accepted as a
 *    figure.** No rail persists the excess — each stamps `outcome: "overpaid"` on
 *    its processed-transaction row and stores the amount that ARRIVED, so the
 *    excess is `amount − what the order asked for`. The subtlety worth a test is
 *    that "what the order asked for" is not the same expression on every rail:
 *    TokoPay's QRIS admin fee is a buyer-side surcharge, so its own overpayment
 *    check compares against `qrisChargeAmount(total)` and a credit computed
 *    against the bare total would hand the buyer the shop's own fee. The first
 *    case drives a REAL rail end to end (`deliverPaidInternalOrder`) rather than
 *    hand-writing the processed row, because a helper that reads a shape no rail
 *    actually writes is a helper that agrees with nothing.
 *
 * 2. **One order can be credited once.** Guarded twice on purpose: a read-then-
 *    refuse for a clean 422, and `wallet_transactions`' own
 *    `UNIQUE (orderId, reason)` underneath it, which is what survives two
 *    requests racing past the read. Both paths are exercised, and the ledger is
 *    asserted balanced and posted to `provider_clearing`/`wallet_liability`
 *    rather than `adjustment` — the equity account this whole posting exists to
 *    avoid.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [444] } };
});

import { Decimal } from "@app/core/money";
import { FinancialTransactionType, LedgerDirection, OrderStatus, PaymentMethod } from "@app/core/enums";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  creditOverpaymentToBalance,
  deliverPaidInternalOrder,
  findOverpaidExcess,
  getAccountBalance,
} from "@app/db";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
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
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({
    data: {
      telegramId: 999_002,
      username: "overpay-admin",
      fullName: "Overpay Admin",
      role: "ADMIN",
      referralCode: `o${Math.random()}`,
    },
  });
  adminId = admin.id;
});

/** A PENDING_PAYMENT order stamped as a Binance Internal Transfer payment — the
 *  rail this file drives for real. */
async function makePendingInternalOrder() {
  const { user, product } = sample;
  const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
  });
  return order;
}

/**
 * A real overpayment: drive the rail with more than the order asked for, so the
 * `processedBinanceTx` row under test is the one the rail itself writes.
 */
async function overpayThroughBinanceRail(excess: Decimal.Value) {
  const order = await makePendingInternalOrder();
  const paid = new Decimal(order.totalAmount).plus(excess);
  const result = await deliverPaidInternalOrder(prisma, {
    orderId: order.id,
    binanceTxId: `tx-over-${order.id}`,
    amount: paid,
  });
  expect(result.status).toBe("delivered");
  const flagged = await prisma.processedBinanceTx.findUniqueOrThrow({
    where: { binanceTxId: `tx-over-${order.id}` },
  });
  expect(flagged.outcome).toBe("overpaid");
  return { order, paid };
}

/** One posting's entries, flattened. */
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

async function expectBalanced(financialTransactionId: number) {
  const rows = await entriesOf(financialTransactionId);
  const sums = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const row of rows) {
    const sum = sums.get(row.currency) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    if (row.direction === LedgerDirection.DEBIT) sum.debit = sum.debit.plus(row.amount);
    else sum.credit = sum.credit.plus(row.amount);
    sums.set(row.currency, sum);
  }
  expect(sums.size).toBeGreaterThan(0);
  for (const [currency, sum] of sums) {
    expect(sum.debit.toString(), `debits != credits in ${currency}`).toBe(sum.credit.toString());
  }
}

describe("findOverpaidExcess", () => {
  it("derives the excess from the rail's own processed row after a real overpayment", async () => {
    const { order, paid } = await overpayThroughBinanceRail("3");

    const found = await findOverpaidExcess(prisma, order.id);

    expect(found).not.toBeNull();
    expect(found!.gateway).toBe(PaymentMethod.BINANCE_INTERNAL);
    expect(found!.receivedAmount.toString()).toBe(paid.toString());
    expect(found!.expectedAmount.toString()).toBe(new Decimal(order.totalAmount).toString());
    expect(found!.excess.toString()).toBe("3");
    expect(found!.currency).toBe(order.currency);
    expect(found!.creditedWalletTransactionId).toBeNull();
  });

  it("returns null for an order no rail flagged", async () => {
    const order = await makePendingInternalOrder();
    await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: `tx-exact-${order.id}`,
      amount: order.totalAmount,
    });

    expect(await findOverpaidExcess(prisma, order.id)).toBeNull();
  });

  it("returns null for an order that does not exist at all", async () => {
    expect(await findOverpaidExcess(prisma, 999_999)).toBeNull();
  });

  it("measures a TokoPay overpayment against the QRIS charge, not the bare total", async () => {
    // TokoPay's admin fee is a buyer-side surcharge, so the buyer is BILLED
    // `qrisChargeAmount(total)` and paying exactly that is not an overpayment.
    // Comparing against `totalAmount` here would invent an excess equal to the
    // shop's own fee and hand it to the buyer.
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentMethod: PaymentMethod.TOKOPAY },
    });
    const billed = qrisChargeAmount(order.totalAmount);
    await prisma.processedTokopayTx.create({
      data: { trxId: `tp-${order.id}`, orderId: order.id, amount: billed.plus("500"), outcome: "overpaid" },
    });

    const found = await findOverpaidExcess(prisma, order.id);

    expect(found!.gateway).toBe(PaymentMethod.TOKOPAY);
    expect(found!.expectedAmount.toString()).toBe(billed.toString());
    expect(found!.excess.toString()).toBe("500");
  });

  it("reads a PayDisini and a NOWPayments row against the bare order total", async () => {
    for (const rail of ["paydisini", "nowpayments"] as const) {
      await resetDb(prisma);
      sample = await buildSampleData(prisma);
      const { user, product } = sample;
      const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
      const table = rail === "paydisini" ? prisma.processedPaydisiniTx : prisma.processedNowpaymentsTx;
      await table.create({
        data: {
          trxId: `${rail}-${order.id}`,
          orderId: order.id,
          amount: new Decimal(order.totalAmount).plus("7"),
          outcome: "overpaid",
        },
      });

      const found = await findOverpaidExcess(prisma, order.id);
      expect(found!.excess.toString(), `wrong excess for ${rail}`).toBe("7");
      expect(found!.expectedAmount.toString()).toBe(new Decimal(order.totalAmount).toString());
    }
  });

  it("reports no excess for a flagged row that records no amount, or an amount at or below the total", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    // A row with a null amount: the rail flagged it but recorded no figure, so
    // there is nothing to derive and inventing one would credit a guess.
    await prisma.processedBinanceTx.create({
      data: { binanceTxId: `no-amount-${order.id}`, orderId: order.id, amount: null, outcome: "overpaid" },
    });
    expect(await findOverpaidExcess(prisma, order.id)).toBeNull();

    // A stale/mis-written row recording less than the total is not an
    // overpayment, so the excess floors at zero rather than going negative.
    await prisma.processedBinanceTx.deleteMany({ where: { orderId: order.id } });
    await prisma.processedBinanceTx.create({
      data: {
        binanceTxId: `too-little-${order.id}`,
        orderId: order.id,
        amount: new Decimal(order.totalAmount).minus("1"),
        outcome: "overpaid",
      },
    });
    const found = await findOverpaidExcess(prisma, order.id);
    expect(found!.excess.toString()).toBe("0");
  });

  it("reports the wallet movement that already credited an excess", async () => {
    const { order } = await overpayThroughBinanceRail("3");
    const { walletTransactionId } = await creditOverpaymentToBalance(prisma, {
      orderId: order.id,
      adminId,
    });

    const found = await findOverpaidExcess(prisma, order.id);

    expect(found!.creditedWalletTransactionId).toBe(walletTransactionId);
  });
});

describe("creditOverpaymentToBalance", () => {
  it("credits the rail's excess to the buyer's wallet and posts it as cash, not equity", async () => {
    // The order is IDR: `createOrderDirect` prices in the shop's central IDR, and
    // stamping the payment method does not change the order's currency. The
    // Binance rail's own overpaid log says "IDR" for the same reason. The credit
    // therefore lands in the IDR balance, and the posting in the `.idr` accounts.
    const { order } = await overpayThroughBinanceRail("3");
    expect(order.currency).toBe("IDR");
    const balanceBefore = new Decimal(
      (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance,
    );
    const adjustmentBefore = await getAccountBalance(prisma, "adjustment.idr");
    const walletLiabilityBefore = await getAccountBalance(prisma, "wallet_liability.idr");
    const clearingBefore = await getAccountBalance(prisma, "provider_clearing.idr");

    const result = await creditOverpaymentToBalance(prisma, { orderId: order.id, adminId });

    expect(result.credited.toString()).toBe("3");
    expect(result.currency).toBe("IDR");

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).minus(balanceBefore).toString()).toBe("3");
    // The other balance is untouched — a credit belongs to one currency only.
    expect(new Decimal(buyer.walletBalanceUsdt).isZero()).toBe(true);

    const movement = await prisma.walletTransaction.findUniqueOrThrow({
      where: { id: result.walletTransactionId },
    });
    expect(movement.reason).toBe("overpaid_credit");
    expect(movement.orderId).toBe(order.id);
    expect(movement.adminId).toBe(adminId);
    expect(movement.currency).toBe("IDR");

    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `wallet:${result.walletTransactionId}` },
    });
    expect(posting.type).toBe(FinancialTransactionType.ADJUSTMENT);
    expect(posting.referenceType).toBe("order");
    expect(posting.referenceId).toBe(order.id);
    await expectBalanced(posting.id);
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: LedgerDirection.DEBIT, amount: "3", currency: "IDR" },
      { code: "wallet_liability.idr", direction: LedgerDirection.CREDIT, amount: "3", currency: "IDR" },
    ]);

    // The whole point of D3, and the direction is worth stating because it is
    // easy to get backwards: `wallet_liability.*` RISES (the shop now owes the
    // buyer 3 more) and `provider_clearing.*` RISES TOO, by the same 3.
    //
    // It rises rather than falling because `provider_clearing` is debit-normal
    // and this posting DEBITS it. The excess was never recognised anywhere:
    // `postOrderPaymentPosting` debited the receivable by the order's total (5)
    // only, so the extra 3 the gateway collected and is still holding had no entry
    // at all. Crediting the buyer recognises that cash for the FIRST time — the
    // gateway owes the shop 3 more, and the shop owes the buyer 3 — which is what
    // makes the pair balance. A FALL in `provider_clearing` would mean the
    // receivable was being drained, and the only thing that drains it is a
    // provider actually paying out (`postSettlementPosting`, task F1).
    //
    // `adjustment.*` — which would claim the shop funded this credit out of its
    // own equity — stays exactly where it was. That is the account this whole
    // posting exists to avoid.
    expect(
      (await getAccountBalance(prisma, "wallet_liability.idr")).minus(walletLiabilityBefore).toString(),
    ).toBe("3");
    expect(
      (await getAccountBalance(prisma, "provider_clearing.idr")).minus(clearingBefore).toString(),
    ).toBe("3");
    expect((await getAccountBalance(prisma, "adjustment.idr")).toString()).toBe(
      adjustmentBefore.toString(),
    );
  });

  it("writes one audit row, as a sentence a shop admin can read", async () => {
    const { order } = await overpayThroughBinanceRail("3");

    await creditOverpaymentToBalance(prisma, { orderId: order.id, adminId });

    const rows = await prisma.auditLog.findMany({ where: { action: "overpayment_credit" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
    expect(rows[0]!.targetType).toBe("order");
    expect(rows[0]!.targetId).toBe(order.id);
    expect(rows[0]!.details).toContain("3");
    expect(rows[0]!.details).not.toMatch(/=/);
  });

  it("refuses a second credit — the double-click guard", async () => {
    const { order } = await overpayThroughBinanceRail("3");
    await creditOverpaymentToBalance(prisma, { orderId: order.id, adminId });

    await expect(creditOverpaymentToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject(
      { key: "error.overpayment_already_credited" },
    );

    // Exactly one movement, one posting, and the balance moved once.
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(1);
    expect(
      await prisma.financialTransaction.count({ where: { type: FinancialTransactionType.ADJUSTMENT } }),
    ).toBe(1);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).toString()).toBe("3");
  });

  it("credits once even when two requests race past the read guard", async () => {
    // The structural backstop: `wallet_transactions` is UNIQUE on
    // (orderId, reason), so the loser's insert is rejected before any balance
    // moves rather than relying on the read-then-refuse above.
    const { order } = await overpayThroughBinanceRail("3");

    const outcomes = await Promise.allSettled([
      creditOverpaymentToBalance(prisma, { orderId: order.id, adminId }),
      creditOverpaymentToBalance(prisma, { orderId: order.id, adminId }),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejection = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect((rejection.reason as { key?: string }).key).toBe("error.overpayment_already_credited");
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(1);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).toString()).toBe("3");
  });

  it("refuses an order no rail flagged as overpaid, moving nothing", async () => {
    const order = await makePendingInternalOrder();
    await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: `tx-exact-${order.id}`,
      amount: order.totalAmount,
    });

    await expect(creditOverpaymentToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject(
      { key: "error.overpayment_none_recorded" },
    );

    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(0);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalanceUsdt).isZero()).toBe(true);
  });

  it("refuses a flagged order whose derived excess is zero, rather than crediting nothing loudly", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    await prisma.processedBinanceTx.create({
      data: {
        binanceTxId: `equal-${order.id}`,
        orderId: order.id,
        amount: order.totalAmount,
        outcome: "overpaid",
      },
    });

    await expect(creditOverpaymentToBalance(prisma, { orderId: order.id, adminId })).rejects.toMatchObject(
      { key: "error.overpayment_none_recorded" },
    );
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(0);
  });

  it("refuses an order that does not exist", async () => {
    await expect(creditOverpaymentToBalance(prisma, { orderId: 999_999, adminId })).rejects.toMatchObject(
      { key: "error.order_not_found" },
    );
  });

  it("credits an IDR excess into the IDR balance, leaving the USDT balance alone", async () => {
    const { user, product } = sample;
    const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentMethod: PaymentMethod.PAYDISINI, currency: "IDR", status: OrderStatus.DELIVERED },
    });
    await prisma.processedPaydisiniTx.create({
      data: {
        trxId: `pd-${order.id}`,
        orderId: order.id,
        amount: new Decimal(order.totalAmount).plus("2500"),
        outcome: "overpaid",
      },
    });

    const result = await creditOverpaymentToBalance(prisma, { orderId: order.id, adminId });

    expect(result.currency).toBe("IDR");
    expect(result.credited.toString()).toBe("2500");
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).toString()).toBe("2500");
    expect(new Decimal(buyer.walletBalanceUsdt).isZero()).toBe(true);
    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `wallet:${result.walletTransactionId}` },
    });
    expect(await entriesOf(posting.id)).toEqual([
      { code: "provider_clearing.idr", direction: LedgerDirection.DEBIT, amount: "2500", currency: "IDR" },
      { code: "wallet_liability.idr", direction: LedgerDirection.CREDIT, amount: "2500", currency: "IDR" },
    ]);
  });

  it("runs inside a caller's own transaction when given one", async () => {
    const { order } = await overpayThroughBinanceRail("3");

    const result = await prisma.$transaction((tx) =>
      creditOverpaymentToBalance(tx, { orderId: order.id, adminId }),
    );

    expect(result.credited.toString()).toBe("3");
    expect(
      await prisma.financialTransaction.count({
        where: { idempotencyKey: `wallet:${result.walletTransactionId}` },
      }),
    ).toBe(1);
  });
});
