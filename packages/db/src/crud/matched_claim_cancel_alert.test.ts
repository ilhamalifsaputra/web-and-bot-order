/**
 * A `matched` ledger claim on a product order that gets cancelled before it
 * was delivered (Game Top-up refactor follow-up, item 2).
 *
 * Every gateway rail commits its `matched` claim on its own, before the
 * delivery transaction. A crash between the two leaves the order
 * PENDING_PAYMENT; if its window lapses first, the expiry sweep cancels it and
 * nothing retries (a reclaim needs the order still PENDING_PAYMENT). The buyer
 * paid and got nothing. `cancelOrder` now tells every admin once, with the
 * existing ADMIN_STALE_PAYMENT event in its `claim_cancelled` wording. It does
 * NOT credit anything and does NOT retag the `matched` row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { NotificationEvent, OrderKind, OrderStatus, PaymentMethod, StockActorType } from "@app/core/enums";
import { cancelExpiredPendingOrder, cancelOrder } from "./orders";
import { resolveAdminIds, ADMIN_IDS_KEY } from "./admins";
import { setSetting, __clearSettingsCacheForTests } from "./settings";

let db: TestDb;
let sample: SampleData;
let admins: number[];
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await resetDb(db.prisma);
  sample = await buildSampleData(db.prisma);
  await setSetting(db.prisma, ADMIN_IDS_KEY, "7101,7102");
  __clearSettingsCacheForTests(db.prisma);
  admins = (await resolveAdminIds(db.prisma)).sort((a, b) => a - b);
});

async function pendingOrder(data: Record<string, unknown> = {}) {
  return db.prisma.order.create({
    data: {
      orderCode: `ORD-CLAIM-${Math.random().toString(36).slice(2, 10)}`,
      userId: sample.user.id,
      subtotalAmount: "50000",
      totalAmount: "50000",
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.TOKOPAY,
      expiresAt: new Date(Date.now() - 60_000),
      ...data,
    },
  });
}

const alertRows = (orderId: number) =>
  db.prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.ADMIN_STALE_PAYMENT }, orderBy: { id: "asc" } });

const SYSTEM = { type: StockActorType.SYSTEM } as const;

describe("cancelling a product order that has a matched ledger claim", () => {
  it("tells every admin exactly once, naming the gateway and the claimed transaction", async () => {
    const order = await pendingOrder();
    await db.prisma.processedTokopayTx.create({ data: { trxId: "TP-CLAIM-1", orderId: order.id, amount: "50000", outcome: "matched" } });

    await db.prisma.$transaction((tx) => cancelExpiredPendingOrder(tx, order.id));

    const rows = await alertRows(order.id);
    expect(rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b)).toEqual(admins);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(admins.map((a) => `claim-cancelled:${order.id}:${a}`).sort());
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({
      order_code: order.orderCode, gateway: "TokoPay", trx_id: "TP-CLAIM-1", reason: "claim_cancelled",
    });
    // Alert only: the claim keeps its outcome and no credit is written.
    expect((await db.prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "TP-CLAIM-1" } })).outcome).toBe("matched");
    expect(await db.prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("labels the shared Bybit ledger by the order's own payment method", async () => {
    const order = await pendingOrder({ paymentMethod: PaymentMethod.BYBIT_BSC, currency: "USDT" });
    await db.prisma.processedBybitTx.create({ data: { bybitTxId: "0xCLAIM", orderId: order.id, amount: "3", outcome: "matched" } });
    await cancelOrder(db.prisma, order.id, "expired", SYSTEM);
    expect(JSON.parse((await alertRows(order.id))[0]!.payloadJson)).toMatchObject({ gateway: "Bybit BSC", trx_id: "0xCLAIM" });
  });

  it("also alerts when the buyer cancels the order themselves", async () => {
    const order = await pendingOrder();
    await db.prisma.processedNowpaymentsTx.create({ data: { trxId: "NP-CLAIM", orderId: order.id, amount: "50000", outcome: "matched" } });
    await db.prisma.$transaction((tx) =>
      cancelOrder(tx, order.id, "user_cancelled", { type: StockActorType.CUSTOMER, customerId: sample.user.id }));
    expect(await alertRows(order.id)).toHaveLength(admins.length);
  });

  it("does not repeat the alert when the order is cancelled a second time", async () => {
    const order = await pendingOrder();
    await db.prisma.processedPaydisiniTx.create({ data: { trxId: "PD-CLAIM", orderId: order.id, amount: "50000", outcome: "matched" } });
    await cancelOrder(db.prisma, order.id, "expired", SYSTEM);
    await cancelOrder(db.prisma, order.id, "admin_cancelled: again", SYSTEM);
    expect(await cancelExpiredPendingOrder(db.prisma, order.id)).toEqual({ cancelled: false });
    expect(await alertRows(order.id)).toHaveLength(admins.length);
  });

  it("stays silent for a wallet top-up, which settles itself late and must never be credited twice", async () => {
    const order = await pendingOrder({ kind: OrderKind.WALLET_TOPUP });
    await db.prisma.processedTokopayTx.create({ data: { trxId: "TP-TOPUP", orderId: order.id, amount: "50000", outcome: "matched" } });
    await cancelOrder(db.prisma, order.id, "expired", SYSTEM);
    expect(await alertRows(order.id)).toHaveLength(0);
  });

  it("stays silent when the order has no matched claim, or only an unmatched or stale one", async () => {
    const none = await pendingOrder();
    await cancelOrder(db.prisma, none.id, "expired", SYSTEM);
    expect(await alertRows(none.id)).toHaveLength(0);
    for (const outcome of ["unmatched", "stale", "delivery_failed"]) {
      const order = await pendingOrder();
      await db.prisma.processedTokopayTx.create({ data: { trxId: `TP-${outcome}`, orderId: order.id, amount: "50000", outcome } });
      await cancelOrder(db.prisma, order.id, "expired", SYSTEM);
      expect(await alertRows(order.id), outcome).toHaveLength(0);
    }
  });

  it("stays silent when the order is already marked paid (its own credit path covers it)", async () => {
    for (const data of [{ paidAt: new Date() }, { paymentState: "PAID" }]) {
      const order = await pendingOrder(data);
      await db.prisma.processedTokopayTx.create({ data: { trxId: `TP-PAID-${order.id}`, orderId: order.id, amount: "50000", outcome: "matched" } });
      // A paid order may only be cancelled after its credit, so give it one.
      await db.prisma.walletTransaction.create({
        data: { userId: sample.user.id, orderId: order.id, delta: "50000", reason: "unfulfilled_credit", balanceAfter: "50000" },
      });
      await cancelOrder(db.prisma, order.id, "expired", SYSTEM);
      expect(await alertRows(order.id), JSON.stringify(data)).toHaveLength(0);
    }
  });

  it("stays silent when the order was not awaiting payment", async () => {
    const order = await pendingOrder({ status: OrderStatus.PENDING_VERIFICATION });
    await db.prisma.processedTokopayTx.create({ data: { trxId: "TP-VERIFY", orderId: order.id, amount: "50000", outcome: "matched" } });
    await cancelOrder(db.prisma, order.id, "admin_cancelled: proof fake", SYSTEM);
    expect(await alertRows(order.id)).toHaveLength(0);
  });
});
