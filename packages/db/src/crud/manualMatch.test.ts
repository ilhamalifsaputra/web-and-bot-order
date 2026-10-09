/**
 * Manual match / dismiss of an "unmatched" payment ledger row on every
 * gateway (crud/manualMatch.ts). Money-critical: every refusal below is a
 * case where settling would deliver goods or credit a wallet for money that
 * is not proven to belong to the order, or settle one payment twice.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [444] } };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  createWalletTopupOrder,
  bulkAddStock,
  recordUnmatchedTx,
  recordUnmatchedBybitTx,
  recordUnmatchedTokopayTx,
  recordUnmatchedPaydisiniTx,
  recordUnmatchedNowpaymentsTx,
  deliverPaidTokopayOrder,
  deliverPaidPaydisiniOrder,
  findUnmatchedLedgerRow,
  manualMatchLedgerTx,
  dismissUnmatchedLedgerTx,
} from "@app/db";
import { AMOUNT_TOLERANCE } from "@app/core/formatters";
import { OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { qrisChargeAmount } from "@app/core/payments/tokopay";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
let adminId: number;
let adminB: number;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
  await Promise.all(Array.from({ length: 4 }, () => prisma.$queryRaw`SELECT 1 AS ok FROM pg_sleep(0.05)`));
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  // The acting admin is a users.id (stock events FK it).
  const mk = (n: number) => prisma.user.create({ data: { telegramId: BigInt(910000 + n), referralCode: `mm-adm${n}` } });
  adminId = (await mk(1)).id;
  adminB = (await mk(2)).id;
});

async function makePendingOrder(method: string, currency: "IDR" | "USDT") {
  const order = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  return prisma.order.update({ where: { id: order.id }, data: { paymentMethod: method, currency } });
}

function makeTopupOrder(method: string, currency: "IDR" | "USDT", amount: string) {
  return prisma.$transaction((tx) =>
    createWalletTopupOrder(tx, {
      userId: sample.user.id,
      amount,
      currency,
      method: method as never,
      ...(currency === "USDT" ? { rate: "16000" } : {}),
    }),
  );
}

async function expectValidation(p: Promise<unknown>, key: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).message).toBe(key);
}

async function wipeStock() {
  await prisma.stockItem.updateMany({ where: { productId: sample.product.id }, data: { status: StockStatus.SOLD } });
}

async function statusMetas(orderId: number) {
  const rows = await prisma.orderStatusHistory.findMany({ where: { orderId }, orderBy: { id: "asc" } });
  return rows.map((r) => r.meta ?? "");
}

describe("findUnmatchedLedgerRow", () => {
  it("throws error.tx_not_found for an unknown reference", async () => {
    await expectValidation(findUnmatchedLedgerRow(prisma, { reference: "nope" }), "error.tx_not_found");
  });

  it("finds the row on its own gateway without being told which", async () => {
    await recordUnmatchedPaydisiniTx(prisma, { trxId: "pd-find-1", amount: "100" });
    const found = await findUnmatchedLedgerRow(prisma, { reference: "pd-find-1" });
    expect(found.gateway).toBe("paydisini");
    expect(found.row.outcome).toBe("unmatched");
    expect(new Decimal(found.row.amount!).equals(100)).toBe(true);
  });

  it("refuses an ambiguous reference with no gateway, and resolves it when the gateway is given", async () => {
    await recordUnmatchedTokopayTx(prisma, { trxId: "dup-ref", amount: "100" });
    await recordUnmatchedPaydisiniTx(prisma, { trxId: "dup-ref", amount: "200" });
    await expectValidation(findUnmatchedLedgerRow(prisma, { reference: "dup-ref" }), "error.tx_reference_ambiguous");
    const found = await findUnmatchedLedgerRow(prisma, { reference: "dup-ref", gateway: "paydisini" });
    expect(found.gateway).toBe("paydisini");
    expect(new Decimal(found.row.amount!).equals(200)).toBe(true);
  });

  it("only looks in the given gateway's table", async () => {
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-only", amount: "100" });
    await expectValidation(findUnmatchedLedgerRow(prisma, { reference: "tp-only", gateway: "bybit" }), "error.tx_not_found");
  });

  it("returns a row whatever its outcome, so callers can say it is not unmatched", async () => {
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-matched", amount: "5", outcome: "matched" } });
    const found = await findUnmatchedLedgerRow(prisma, { reference: "by-matched" });
    expect(found).toMatchObject({ gateway: "bybit", row: { outcome: "matched" } });
  });
});

describe("manualMatchLedgerTx — success on each gateway", () => {
  it("TokoPay: claims the row, settles the order and names the admin in the status history", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-ok-1", amount: qrisChargeAmount(order.totalAmount) });

    const result = await manualMatchLedgerTx(prisma, { reference: "tp-ok-1", orderId: order.id, adminId });
    expect(result.gateway).toBe("tokopay");
    expect(result.kind).toBe("delivered");
    expect(result.order.id).toBe(order.id);
    expect(result.credentials.length).toBe(1);

    const row = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-ok-1" } });
    expect(row).toMatchObject({ outcome: "matched", orderId: order.id });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.DELIVERED);
    expect((await statusMetas(order.id)).some((m) => m.includes(`manual_match`) && m.includes(`admin_id=${adminId}`))).toBe(true);
  });

  it("PayDisini: claims the row and settles the order", async () => {
    const order = await makePendingOrder(PaymentMethod.PAYDISINI, "IDR");
    await recordUnmatchedPaydisiniTx(prisma, { trxId: "pd-ok-1", amount: order.totalAmount });

    const result = await manualMatchLedgerTx(prisma, { reference: "pd-ok-1", orderId: order.id, adminId });
    expect(result.gateway).toBe("paydisini");
    expect(result.kind).toBe("delivered");
    const row = await prisma.processedPaydisiniTx.findUniqueOrThrow({ where: { trxId: "pd-ok-1" } });
    expect(row).toMatchObject({ outcome: "matched", orderId: order.id });
    expect((await statusMetas(order.id)).some((m) => m.includes(`admin_id=${adminId}`))).toBe(true);
  });

  it("Bybit internal transfer: claims the unmatched row and settles the BYBIT order", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-ok-1", amount: order.totalAmount });

    const result = await manualMatchLedgerTx(prisma, { reference: "by-ok-1", orderId: order.id, adminId });
    expect(result.gateway).toBe("bybit");
    expect(result.kind).toBe("delivered");
    const row = await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "by-ok-1" } });
    expect(row).toMatchObject({ outcome: "matched", orderId: order.id });
    const settled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(settled.status).toBe(OrderStatus.DELIVERED);
    expect(settled.bybitTxid).toBe("by-ok-1");
    expect(settled.paymentState).toBe("PAID");
    expect((await statusMetas(order.id)).some((m) => m.includes("manual_match") && m.includes(`admin_id=${adminId}`))).toBe(true);
  });

  it("Bybit BSC: the shared bybit row settles a BYBIT_BSC order", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT_BSC, "USDT");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "0xbsc-ok-1", amount: order.totalAmount });

    const result = await manualMatchLedgerTx(prisma, { reference: "0xbsc-ok-1", orderId: order.id, adminId });
    expect(result.gateway).toBe("bybit");
    expect(result.kind).toBe("delivered");
    const row = await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "0xbsc-ok-1" } });
    expect(row).toMatchObject({ outcome: "matched", orderId: order.id });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).bybitTxid).toBe("0xbsc-ok-1");
  });

  it("Bybit accepts an amount short of the total by no more than the poller's tolerance", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    const amount = new Decimal(order.totalAmount).minus(AMOUNT_TOLERANCE);
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-tol-1", amount });
    const result = await manualMatchLedgerTx(prisma, { reference: "by-tol-1", orderId: order.id, adminId });
    expect(result.kind).toBe("delivered");
  });

  it("a WALLET_TOPUP order matched through TokoPay credits the buyer's rupiah wallet", async () => {
    const order = await makeTopupOrder(PaymentMethod.TOKOPAY, "IDR", "20000");
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-topup-1", amount: qrisChargeAmount(order.totalAmount) });

    const result = await manualMatchLedgerTx(prisma, { reference: "tp-topup-1", orderId: order.id, adminId });
    expect(result.kind).toBe("delivered");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalance).equals(order.totalAmount)).toBe(true);
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-topup-1" } })).outcome).toBe("matched");
  });

  it("a WALLET_TOPUP order matched through Bybit credits the buyer's USDT wallet", async () => {
    const order = await makeTopupOrder(PaymentMethod.BYBIT, "USDT", "10");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-topup-1", amount: order.totalAmount });

    const result = await manualMatchLedgerTx(prisma, { reference: "by-topup-1", orderId: order.id, adminId });
    expect(result.kind).toBe("delivered");
    const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(user.walletBalanceUsdt).equals(order.totalAmount)).toBe(true);
    expect((await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "by-topup-1" } })).outcome).toBe("matched");
  });

  it("Binance still delegates to manualMatchTx", async () => {
    const order = await makePendingOrder(PaymentMethod.BINANCE_INTERNAL, "USDT");
    await recordUnmatchedTx(prisma, { binanceTxId: "bn-ok-1", amount: order.totalAmount });
    const result = await manualMatchLedgerTx(prisma, { reference: "bn-ok-1", orderId: order.id, adminId });
    expect(result.gateway).toBe("binance");
    expect(result.kind).toBe("delivered");
    const row = await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "bn-ok-1" } });
    expect(row).toMatchObject({ outcome: "matched", orderId: order.id });
  });
});

describe("manualMatchLedgerTx — refusals", () => {
  it("refuses every NOWPayments row: its amount is in the buyer's pay coin and cannot be verified", async () => {
    const order = await makePendingOrder(PaymentMethod.NOWPAYMENTS, "USDT");
    await recordUnmatchedNowpaymentsTx(prisma, { trxId: "np-1", amount: "1000" });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "np-1", orderId: order.id, adminId }),
      "error.manual_match_nowpayments_unverifiable",
    );
    expect((await prisma.processedNowpaymentsTx.findUniqueOrThrow({ where: { trxId: "np-1" } })).outcome).toBe("unmatched");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it.each(["matched", "dismissed", "delivery_failed"])("refuses a row whose outcome is %s", async (outcome) => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await prisma.processedTokopayTx.create({ data: { trxId: `tp-${outcome}`, amount: qrisChargeAmount(order.totalAmount), outcome } });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: `tp-${outcome}`, orderId: order.id, adminId }),
      "error.tx_not_unmatched",
    );
  });

  it("refuses a bybit row that is not unmatched", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    await prisma.processedBybitTx.create({ data: { bybitTxId: "by-dismissed", amount: order.totalAmount, outcome: "dismissed" } });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "by-dismissed", orderId: order.id, adminId }),
      "error.tx_not_unmatched",
    );
  });

  it("refuses an unknown reference", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await expectValidation(manualMatchLedgerTx(prisma, { reference: "ghost", orderId: order.id, adminId }), "error.tx_not_found");
  });

  it("refuses an ambiguous reference when no gateway is given", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await recordUnmatchedTokopayTx(prisma, { trxId: "amb-1", amount: qrisChargeAmount(order.totalAmount) });
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "amb-1", amount: "5" });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "amb-1", orderId: order.id, adminId }),
      "error.tx_reference_ambiguous",
    );
    const result = await manualMatchLedgerTx(prisma, { reference: "amb-1", gateway: "tokopay", orderId: order.id, adminId });
    expect(result.gateway).toBe("tokopay");
  });

  it("refuses a missing order", async () => {
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-no-order", amount: "100000" });
    await expectValidation(manualMatchLedgerTx(prisma, { reference: "tp-no-order", orderId: 999999, adminId }), "error.order_not_found");
  });

  it("refuses an order that is not PENDING_PAYMENT", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-cancelled", amount: order.totalAmount });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "by-cancelled", orderId: order.id, adminId }),
      "error.order_not_pending",
    );
    expect((await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "by-cancelled" } })).outcome).toBe("unmatched");
  });

  it("refuses an order whose payment method is not the row's gateway", async () => {
    const order = await makePendingOrder(PaymentMethod.PAYDISINI, "IDR");
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-wrong-method", amount: "1000000" });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "tp-wrong-method", orderId: order.id, adminId }),
      "error.payment_method_mismatch",
    );
    const binanceOrder = await makePendingOrder(PaymentMethod.BINANCE_INTERNAL, "USDT");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-wrong-method", amount: "100" });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "by-wrong-method", orderId: binanceOrder.id, adminId }),
      "error.payment_method_mismatch",
    );
  });

  it("refuses an order in a different currency from the gateway", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "IDR");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-idr", amount: "1000000" });
    const err = await manualMatchLedgerTx(prisma, { reference: "by-idr", orderId: order.id, adminId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).message).toBe("error.payment_currency_mismatch");
    expect((err as ValidationError).formatArgs).toEqual({ paymentCurrency: "USDT", orderCurrency: "IDR" });
  });

  it("refuses a row with no amount or a zero amount", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await prisma.processedTokopayTx.create({ data: { trxId: "tp-null-amount", amount: null, outcome: "unmatched" } });
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-zero-amount", amount: 0 });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "tp-null-amount", orderId: order.id, adminId }),
      "error.manual_match_amount_unknown",
    );
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "tp-zero-amount", orderId: order.id, adminId }),
      "error.manual_match_amount_unknown",
    );
  });

  it("TokoPay: refuses an amount that covers the total but not the QRIS charge", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-short", amount: order.totalAmount });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "tp-short", orderId: order.id, adminId }),
      "error.manual_match_amount_short",
    );
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-short" } })).outcome).toBe("unmatched");
  });

  it("PayDisini: refuses an amount below the order total", async () => {
    const order = await makePendingOrder(PaymentMethod.PAYDISINI, "IDR");
    await recordUnmatchedPaydisiniTx(prisma, { trxId: "pd-short", amount: new Decimal(order.totalAmount).minus("0.01") });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "pd-short", orderId: order.id, adminId }),
      "error.manual_match_amount_short",
    );
  });

  it("Bybit: refuses an amount short by more than the tolerance", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    const amount = new Decimal(order.totalAmount).minus(AMOUNT_TOLERANCE).minus("0.0001");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-short", amount });
    await expectValidation(
      manualMatchLedgerTx(prisma, { reference: "by-short", orderId: order.id, adminId }),
      "error.manual_match_amount_short",
    );
    expect((await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "by-short" } })).outcome).toBe("unmatched");
  });
});

describe("manualMatchLedgerTx — failure leaves the row matchable again", () => {
  it("TokoPay: a delivery that throws (out of stock) reverts the row to unmatched and leaves the order unpaid", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-fail-1", amount: qrisChargeAmount(order.totalAmount) });
    await wipeStock();

    await expect(manualMatchLedgerTx(prisma, { reference: "tp-fail-1", orderId: order.id, adminId })).rejects.toBeTruthy();
    const row = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-fail-1" } });
    expect(row).toMatchObject({ outcome: "unmatched", orderId: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("Bybit: a delivery that throws rolls the whole match back", async () => {
    const order = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-fail-1", amount: order.totalAmount });
    await wipeStock();

    await expect(manualMatchLedgerTx(prisma, { reference: "by-fail-1", orderId: order.id, adminId })).rejects.toBeTruthy();
    const row = await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "by-fail-1" } });
    expect(row).toMatchObject({ outcome: "unmatched", orderId: null });
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(after.bybitTxid).toBeNull();
  });
});

describe("QRIS deliver functions in manual mode", () => {
  it("TokoPay manual mode cannot claim a delivery_failed row", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await prisma.processedTokopayTx.create({
      data: { trxId: "tp-df-1", amount: qrisChargeAmount(order.totalAmount), outcome: "delivery_failed" },
    });
    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "tp-df-1",
      amount: qrisChargeAmount(order.totalAmount),
      manual: { adminId },
    });
    expect(result.status).toBe("already_processed");
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-df-1" } })).outcome).toBe("delivery_failed");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("PayDisini manual mode cannot claim a delivery_failed row", async () => {
    const order = await makePendingOrder(PaymentMethod.PAYDISINI, "IDR");
    await prisma.processedPaydisiniTx.create({ data: { trxId: "pd-df-1", amount: order.totalAmount, outcome: "delivery_failed" } });
    const result = await deliverPaidPaydisiniOrder(prisma, {
      orderId: order.id,
      trxId: "pd-df-1",
      amount: order.totalAmount,
      manual: { adminId },
    });
    expect(result.status).toBe("already_processed");
    expect((await prisma.processedPaydisiniTx.findUniqueOrThrow({ where: { trxId: "pd-df-1" } })).outcome).toBe("delivery_failed");
  });

  it("TokoPay manual mode on an order that is no longer payable puts the row back to unmatched, not stale", async () => {
    const order = await makePendingOrder(PaymentMethod.TOKOPAY, "IDR");
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-stale-1", amount: qrisChargeAmount(order.totalAmount) });
    const result = await deliverPaidTokopayOrder(prisma, {
      orderId: order.id,
      trxId: "tp-stale-1",
      amount: qrisChargeAmount(order.totalAmount),
      manual: { adminId },
    });
    expect(result.status).toBe("stale");
    const row = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-stale-1" } });
    expect(row).toMatchObject({ outcome: "unmatched", orderId: null });
  });

  it("PayDisini manual mode reverts the row to unmatched when delivery throws", async () => {
    const order = await makePendingOrder(PaymentMethod.PAYDISINI, "IDR");
    await recordUnmatchedPaydisiniTx(prisma, { trxId: "pd-fail-1", amount: order.totalAmount });
    await wipeStock();
    await expect(
      deliverPaidPaydisiniOrder(prisma, { orderId: order.id, trxId: "pd-fail-1", amount: order.totalAmount, manual: { adminId } }),
    ).rejects.toBeTruthy();
    const row = await prisma.processedPaydisiniTx.findUniqueOrThrow({ where: { trxId: "pd-fail-1" } });
    expect(row).toMatchObject({ outcome: "unmatched", orderId: null });
  });
});

describe("manualMatchLedgerTx — true concurrency", () => {
  it("two admins matching one bybit row to two orders: exactly one wins, only one order is paid", async () => {
    await bulkAddStock(prisma, sample.product.id, ["race-cred-1", "race-cred-2"]);
    const a = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    const b = await makePendingOrder(PaymentMethod.BYBIT, "USDT");
    // Same total on both, so whichever wins is an exact (not overpaid) match.
    await prisma.order.update({ where: { id: b.id }, data: { totalAmount: a.totalAmount } });
    const amount = a.totalAmount;
    await recordUnmatchedBybitTx(prisma, { bybitTxId: "by-race-1", amount });

    const results = await Promise.allSettled([
      manualMatchLedgerTx(prisma, { reference: "by-race-1", orderId: a.id, adminId }),
      manualMatchLedgerTx(prisma, { reference: "by-race-1", orderId: b.id, adminId: adminB }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ValidationError);
    expect((rejected[0]!.reason as ValidationError).message).toBe("error.tx_not_unmatched");

    const orders = await prisma.order.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(orders.filter((o) => o.status === OrderStatus.DELIVERED).length).toBe(1);
    expect(orders.filter((o) => o.status === OrderStatus.PENDING_PAYMENT).length).toBe(1);
    const row = await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: "by-race-1" } });
    expect(row.outcome).toBe("matched");
    expect([a.id, b.id]).toContain(row.orderId);
  });
});

describe("dismissUnmatchedLedgerTx", () => {
  const seeders = {
    bybit: (ref: string) => recordUnmatchedBybitTx(prisma, { bybitTxId: ref, amount: "5" }),
    tokopay: (ref: string) => recordUnmatchedTokopayTx(prisma, { trxId: ref, amount: "5" }),
    paydisini: (ref: string) => recordUnmatchedPaydisiniTx(prisma, { trxId: ref, amount: "5" }),
    nowpayments: (ref: string) => recordUnmatchedNowpaymentsTx(prisma, { trxId: ref, amount: "5" }),
  } as const;
  const outcomeOf = async (gateway: keyof typeof seeders, ref: string) => {
    switch (gateway) {
      case "bybit":
        return (await prisma.processedBybitTx.findUniqueOrThrow({ where: { bybitTxId: ref } })).outcome;
      case "tokopay":
        return (await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: ref } })).outcome;
      case "paydisini":
        return (await prisma.processedPaydisiniTx.findUniqueOrThrow({ where: { trxId: ref } })).outcome;
      case "nowpayments":
        return (await prisma.processedNowpaymentsTx.findUniqueOrThrow({ where: { trxId: ref } })).outcome;
    }
  };

  it.each(Object.keys(seeders) as (keyof typeof seeders)[])("%s: dismisses an unmatched row", async (gateway) => {
    await seeders[gateway](`dis-${gateway}`);
    const result = await dismissUnmatchedLedgerTx(prisma, { reference: `dis-${gateway}` });
    expect(result.gateway).toBe(gateway);
    expect(await outcomeOf(gateway, `dis-${gateway}`)).toBe("dismissed");
  });

  it.each(Object.keys(seeders) as (keyof typeof seeders)[])("%s: refuses a row that is not unmatched", async (gateway) => {
    await seeders[gateway](`dis2-${gateway}`);
    await dismissUnmatchedLedgerTx(prisma, { reference: `dis2-${gateway}`, gateway });
    await expectValidation(dismissUnmatchedLedgerTx(prisma, { reference: `dis2-${gateway}`, gateway }), "error.tx_not_unmatched");
  });

  it("binance still delegates to dismissUnmatchedTx", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "dis-bn", amount: "5" });
    const result = await dismissUnmatchedLedgerTx(prisma, { reference: "dis-bn" });
    expect(result.gateway).toBe("binance");
    expect((await prisma.processedBinanceTx.findUniqueOrThrow({ where: { binanceTxId: "dis-bn" } })).outcome).toBe("dismissed");
  });

  it("refuses an unknown reference", async () => {
    await expectValidation(dismissUnmatchedLedgerTx(prisma, { reference: "ghost" }), "error.tx_not_found");
  });
});
