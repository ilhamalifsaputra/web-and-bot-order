/**
 * A wallet top-up that the buyer OVERPAID must be made visible exactly the way
 * an overpaid product order already is (task A4, money audit 2026-10-04).
 *
 * Every rail's deliver function used to return from its `WALLET_TOPUP` branch
 * before the overpayment check product orders get, and `settleWalletTopup`
 * credits `order.totalAmount` whatever arrived — so a buyer topping up 50 USDT
 * who sent 58 was credited 50.046 and the 7.954 excess was recorded nowhere: no
 * `outcome: "overpaid"` on the rail's ledger row, no `ADMIN_OVERPAID` DM, and so
 * no Overpayment card on the admin order page (`findOverpaidExcess` reads that
 * ledger outcome) to hand it back from.
 *
 * Deliberately NOT changed: the credited amount. Crediting the excess
 * automatically is a business decision that was deferred; this pins only that
 * the excess is flagged, alerted once, and resolvable by an admin.
 *
 * Every one of the six top-up-capable rails runs the same table of cases:
 *  - paying exactly what the rail billed → no flag;
 *  - (USDT rails) paying inside the matcher's 0.001 tolerance BELOW the total
 *    → no flag (an excess of zero or less is never an overpayment — product
 *    orders flag any excess above zero and nothing else, and so does this);
 *  - paying over (the smallest step, and for USDT the matcher's own cap
 *    max(2, 20%)) → ledger "overpaid", one ADMIN_OVERPAID per admin, credit
 *    still equals the order total;
 *  - the same transaction delivered again → still exactly one alert, still
 *    credited once.
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
  createWalletTopupOrder,
  deliverPaidInternalOrder,
  deliverPaidBybitOrder,
  deliverPaidBybitBscOrder,
  deliverPaidNowpaymentsOrder,
  deliverPaidTokopayOrder,
  deliverPaidPaydisiniOrder,
  findOverpaidExcess,
  creditOverpaymentToBalance,
  flagWalletTopupOverpayment,
  OVERPAID_CREDIT_REASON,
} from "@app/db";
import { NotificationEvent, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { checkNowpaymentsAmount, nowpaymentsInvoicePrice } from "@app/core/payments/nowpayments";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

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
});

type Order = Awaited<ReturnType<typeof createWalletTopupOrder>>;

interface Rail {
  name: string;
  method: PaymentMethod;
  currency: "USDT" | "IDR";
  topupAmount: string;
  /** What the rail bills the buyer for this order — TokoPay adds its QRIS
   *  surcharge on top, every other rail bills the bare total. */
  billed: (order: Order) => Decimal;
  deliver: (orderId: number, txId: string, amount: Decimal.Value) => Promise<{ status: string }>;
  ledgerOutcome: (txId: string) => Promise<string | undefined>;
}

const rails: Rail[] = [
  {
    name: "Binance Internal",
    method: PaymentMethod.BINANCE_INTERNAL,
    currency: "USDT",
    topupAmount: "50",
    billed: (o) => new Decimal(o.totalAmount),
    deliver: (orderId, binanceTxId, amount) => deliverPaidInternalOrder(prisma, { orderId, binanceTxId, amount }),
    ledgerOutcome: async (id) =>
      (await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: id } }))?.outcome,
  },
  {
    name: "Bybit",
    method: PaymentMethod.BYBIT,
    currency: "USDT",
    topupAmount: "50",
    billed: (o) => new Decimal(o.totalAmount),
    deliver: (orderId, bybitTxId, amount) => deliverPaidBybitOrder(prisma, { orderId, bybitTxId, amount }),
    ledgerOutcome: async (id) => (await prisma.processedBybitTx.findUnique({ where: { bybitTxId: id } }))?.outcome,
  },
  {
    name: "Bybit BSC",
    method: PaymentMethod.BYBIT_BSC,
    currency: "USDT",
    topupAmount: "50",
    billed: (o) => new Decimal(o.totalAmount),
    deliver: (orderId, bybitTxId, amount) => deliverPaidBybitBscOrder(prisma, { orderId, bybitTxId, amount }),
    ledgerOutcome: async (id) => (await prisma.processedBybitTx.findUnique({ where: { bybitTxId: id } }))?.outcome,
  },
  {
    name: "NOWPayments",
    method: PaymentMethod.NOWPAYMENTS,
    currency: "USDT",
    topupAmount: "50",
    // The amount handed to the rail is checkNowpaymentsAmount's value in the
    // order's currency, so paying exactly as asked arrives as the bare total.
    billed: (o) => new Decimal(o.totalAmount),
    deliver: (orderId, trxId, amount) => deliverPaidNowpaymentsOrder(prisma, { orderId, trxId, amount }),
    ledgerOutcome: async (id) => (await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: id } }))?.outcome,
  },
  {
    name: "TokoPay",
    method: PaymentMethod.TOKOPAY,
    currency: "IDR",
    topupAmount: "50000",
    billed: (o) => qrisChargeAmount(o.totalAmount),
    deliver: (orderId, trxId, amount) => deliverPaidTokopayOrder(prisma, { orderId, trxId, amount }),
    ledgerOutcome: async (id) => (await prisma.processedTokopayTx.findUnique({ where: { trxId: id } }))?.outcome,
  },
  {
    name: "PayDisini",
    method: PaymentMethod.PAYDISINI,
    currency: "IDR",
    topupAmount: "50000",
    billed: (o) => new Decimal(o.totalAmount),
    deliver: (orderId, trxId, amount) => deliverPaidPaydisiniOrder(prisma, { orderId, trxId, amount }),
    ledgerOutcome: async (id) => (await prisma.processedPaydisiniTx.findUnique({ where: { trxId: id } }))?.outcome,
  },
];

/** The amount-matcher's overpayment cap (apps/order-bot/src/payments/amountMatching.ts) —
 *  the largest overpayment a USDT poller will still match to an order. */
const overpaymentCap = (total: Decimal) => Decimal.max(2, total.times("0.2"));

async function makeTopup(rail: Rail): Promise<Order> {
  const order = await prisma.$transaction((tx) =>
    createWalletTopupOrder(tx, {
      userId: sample.user.id,
      amount: rail.topupAmount,
      currency: rail.currency,
      method: rail.method,
      ...(rail.currency === "USDT" ? { rate: "16000" } : {}),
    } as Parameters<typeof createWalletTopupOrder>[1]),
  );
  expect(order.kind).toBe(OrderKind.WALLET_TOPUP);
  return order;
}

async function balance(currency: "USDT" | "IDR"): Promise<Decimal> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  return new Decimal(currency === "USDT" ? user.walletBalanceUsdt : user.walletBalance);
}

async function overpaidAlerts(orderId: number) {
  return prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.ADMIN_OVERPAID } });
}

describe.each(rails)("$name wallet top-up overpayment", (rail) => {
  it("paying exactly what the rail billed is credited the total and NOT flagged", async () => {
    const order = await makeTopup(rail);
    const txId = `${rail.method}-exact`;
    const before = await balance(rail.currency);

    const result = await rail.deliver(order.id, txId, rail.billed(order));

    expect(result.status).toBe("delivered");
    expect(await rail.ledgerOutcome(txId)).toBe("matched");
    expect(await overpaidAlerts(order.id)).toHaveLength(0);
    expect((await balance(rail.currency)).minus(before).equals(order.totalAmount)).toBe(true);
    expect(await findOverpaidExcess(prisma, order.id)).toBeNull();
  });

  if (rail.currency === "USDT") {
    it("paying inside the matcher's tolerance below the total is NOT flagged", async () => {
      const order = await makeTopup(rail);
      const txId = `${rail.method}-within-tolerance`;

      const result = await rail.deliver(order.id, txId, rail.billed(order).minus("0.0005"));

      expect(result.status).toBe("delivered");
      expect(await rail.ledgerOutcome(txId)).toBe("matched");
      expect(await overpaidAlerts(order.id)).toHaveLength(0);
    });
  }

  const overpayments =
    rail.currency === "USDT"
      ? [
          { label: "the matcher's tolerance (0.001)", excess: (_o: Order) => new Decimal("0.001") },
          { label: "one cent", excess: (_o: Order) => new Decimal("0.01") },
          { label: "the matcher's overpayment cap max(2, 20%)", excess: (o: Order) => overpaymentCap(new Decimal(o.totalAmount)) },
        ]
      : [
          { label: "one rupiah", excess: (_o: Order) => new Decimal("1") },
          { label: "5,000 rupiah", excess: (_o: Order) => new Decimal("5000") },
        ];

  it.each(overpayments)("overpaying by $label flags the ledger row, alerts once, and still credits only the total", async ({ excess: excessOf }) => {
    const order = await makeTopup(rail);
    const billed = rail.billed(order);
    const excess = excessOf(order);
    const txId = `${rail.method}-overpaid-${excess.toString()}`;
    const paid = billed.plus(excess);
    const before = await balance(rail.currency);

    const result = await rail.deliver(order.id, txId, paid);

    expect(result.status).toBe("delivered");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.DELIVERED);
    // The credited amount is deliberately unchanged: the order total, not what arrived.
    expect((await balance(rail.currency)).minus(before).equals(order.totalAmount)).toBe(true);
    expect(await rail.ledgerOutcome(txId)).toBe("overpaid");

    const alerts = await overpaidAlerts(order.id);
    expect(alerts).toHaveLength(1); // one resolved admin (ADMIN_IDS [444])
    const payload = JSON.parse(alerts[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(444);
    expect(payload.order_code).toBe(order.orderCode);
    expect(new Decimal(payload.paid as string).equals(paid)).toBe(true);
    expect(new Decimal(payload.expected as string).equals(billed)).toBe(true);
    expect(new Decimal(payload.excess as string).equals(excess)).toBe(true);
    expect(payload.currency).toBe(rail.currency);
    // Tells the admin DM to say "credited" rather than "delivered".
    expect(payload.wallet_topup).toBe(true);

    // Re-delivering the same transaction (a re-sent webhook, the next poller
    // tick) must neither alert again nor credit again.
    const again = await rail.deliver(order.id, txId, paid);
    expect(again.status).toBe("already_processed");
    expect(await overpaidAlerts(order.id)).toHaveLength(1);
    expect((await balance(rail.currency)).minus(before).equals(order.totalAmount)).toBe(true);

    // The admin order page's Overpayment card reads exactly this.
    const found = await findOverpaidExcess(prisma, order.id);
    expect(found).not.toBeNull();
    expect(found!.excess.equals(excess)).toBe(true);
    expect(found!.creditedWalletTransactionId).toBeNull();
  });
});

describe("NOWPayments wallet top-up paid exactly as invoiced", () => {
  // A 3dp unique-cents total (e.g. 50.046) is invoiced rounded to the cent
  // (nowpaymentsInvoicePrice). Paying that invoice exactly is paying exactly
  // as asked: checkNowpaymentsAmount values it at the bare total, so the
  // cents rounding never reads as an overpayment.
  it("paying the invoice exactly is NOT flagged overpaid", async () => {
    const order = await makeTopup(rails.find((r) => r.method === PaymentMethod.NOWPAYMENTS)!);
    const invoicePrice = nowpaymentsInvoicePrice(order.totalAmount);
    expect(invoicePrice.equals(order.totalAmount)).toBe(false); // the case under test: a sub-cent total
    const check = checkNowpaymentsAmount(
      { priceAmount: invoicePrice, priceCurrency: "usd", payAmount: invoicePrice, actuallyPaid: invoicePrice },
      order.totalAmount,
    );
    if (!check.ok) throw new Error(check.reason);

    const result = await deliverPaidNowpaymentsOrder(prisma, { orderId: order.id, trxId: "np-invoice-exact", amount: check.amount });

    expect(result.status).toBe("delivered");
    expect((await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "np-invoice-exact" } }))?.outcome).toBe("matched");
    expect(await overpaidAlerts(order.id)).toHaveLength(0);
  });
});

describe("flagWalletTopupOverpayment", () => {
  it("does nothing when the settlement credited nothing (another path already settled the top-up)", async () => {
    const order = await makeTopup(rails[0]!);
    const markLedgerOverpaid = vi.fn(async () => undefined);

    const flagged = await prisma.$transaction((tx) =>
      flagWalletTopupOverpayment(tx, {
        order,
        credited: new Decimal(0),
        paid: new Decimal(order.totalAmount).plus("8"),
        expected: order.totalAmount,
        rail: "Binance Internal",
        markLedgerOverpaid,
      }),
    );

    expect(flagged).toBeNull();
    expect(markLedgerOverpaid).not.toHaveBeenCalled();
    expect(await overpaidAlerts(order.id)).toHaveLength(0);
  });
});

describe("an overpaid wallet top-up can be resolved by an admin", () => {
  it("creditOverpaymentToBalance hands back exactly the excess, once, alongside the top-up credit", async () => {
    const rail = rails[0]!; // Binance Internal
    const admin = await prisma.user.create({
      data: { telegramId: 999_003, username: "topup-overpay-admin", fullName: "Admin", role: "ADMIN", referralCode: `a${Math.random()}` },
    });
    const adminId = admin.id;
    const order = await makeTopup(rail);
    const excess = new Decimal("7.954");
    const before = await balance("USDT");

    await rail.deliver(order.id, "binance-resolve", new Decimal(order.totalAmount).plus(excess));
    const credit = await creditOverpaymentToBalance(prisma, { orderId: order.id, adminId });

    expect(credit.credited.equals(excess)).toBe(true);
    expect((await balance("USDT")).minus(before).equals(new Decimal(order.totalAmount).plus(excess))).toBe(true);
    const rows = await prisma.walletTransaction.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
    expect(rows.map((r) => r.reason)).toEqual(["wallet_topup", OVERPAID_CREDIT_REASON]);
    await expect(creditOverpaymentToBalance(prisma, { orderId: order.id, adminId })).rejects.toThrow(
      "error.overpayment_already_credited",
    );
  });
});
