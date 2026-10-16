/**
 * Backend audit A4: an order that reached UNDERPAID (part of the money
 * arrived) or FAILED used to keep its reserved stock, voucher use and wallet
 * hold forever, because the expiry sweep only ever looked at PENDING_PAYMENT.
 *
 * `sweepAgedUnderpaidAndFailedOrders` closes that gap:
 *  - an UNDERPAID product order older than the owner's TTL is resolved through
 *    the existing refund-to-wallet flow (`refundUnderpaidOrderTx`): the amount
 *    that actually arrived goes to the buyer's balance in the order's own
 *    currency, and every hold (stock, wallet credit spent, voucher) is released;
 *  - anything the sweep cannot resolve safely (a wallet top-up, no recorded
 *    received amount, an order the supplier may still complete) is left as it
 *    is and raised to the admins once;
 *  - a FAILED order is never changed automatically (it is usually fully paid);
 *    the admins get one aging alert for it.
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
  markOrderUnderpaid,
  markUnderpaid,
  createWalletTopupOrder,
  setSetting,
  transitionOrderStatus,
  sweepAgedUnderpaidAndFailedOrders,
  autoResolveExpiredUnderpaidOrder,
  UNDERPAID_AUTO_RESOLVE_HOURS_KEY,
  FAILED_ORDER_ALERT_HOURS_KEY,
  __clearSettingsCacheForTests,
} from "@app/db";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, StockStatus } from "@app/core/enums";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

const HOUR = 3_600_000;
const NOW = new Date("2026-10-16T12:00:00Z");

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  __clearSettingsCacheForTests(prisma);
  sample = await buildSampleData(prisma);
  // Auto-refund is OFF by default; the tests that exercise it switch it on
  // explicitly, the way an owner would (the default itself is pinned below).
  await setSetting(prisma, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, "72");
});

/** Make the order look like it entered `status` `hoursAgo` hours before NOW. */
async function ageStatus(orderId: number, status: string, hoursAgo: number) {
  await prisma.orderStatusHistory.updateMany({
    where: { orderId, status },
    data: { occurredAt: new Date(NOW.getTime() - hoursAgo * HOUR) },
  });
}

/**
 * A TokoPay (IDR) order for the sample SKU that holds all three things the
 * audit names: one reserved stock row, the SAVE10 voucher, and 1 rupiah of
 * the buyer's wallet credit. Then 2 rupiah arrive and the rail flags it
 * UNDERPAID.
 */
async function makeUnderpaidQrisOrder(received = "2") {
  await prisma.user.update({ where: { id: sample.user.id }, data: { walletBalance: "10" } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const created = (await createOrderDirect(prisma, {
    channel: "bot",
    user,
    productId: sample.product.id,
    quantity: 1,
    voucherCode: "SAVE10",
    walletAmount: "1",
  }))!;
  await prisma.order.update({ where: { id: created.id }, data: { paymentMethod: PaymentMethod.TOKOPAY, currency: "IDR" } });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  expect(new Decimal(order.walletUsed).toString()).toBe("1");
  expect(order.voucherId).toBe(sample.voucher.id);
  expect(
    await markOrderUnderpaid(prisma, {
      orderId: order.id,
      gateway: "TOKOPAY",
      receivedAmount: received,
      expectedAmount: order.totalAmount,
    }),
  ).toBe(true);
  return order;
}

async function walletIdr() {
  return new Decimal((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance).toString();
}
async function reservedFor(orderId: number) {
  return prisma.stockItem.count({ where: { orderId, status: StockStatus.RESERVED } });
}
async function statusOf(orderId: number) {
  return (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
}
async function reviewAlerts(orderId: number) {
  return prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.ORDER_PIPELINE_FAILED } });
}

describe("sweepAgedUnderpaidAndFailedOrders — UNDERPAID product orders", () => {
  it("is OFF by default: with no setting row an aged UNDERPAID order is neither refunded nor alerted", async () => {
    await prisma.setting.delete({ where: { key: UNDERPAID_AUTO_RESOLVE_HOURS_KEY } });
    __clearSettingsCacheForTests(prisma);
    const order = await makeUnderpaidQrisOrder();
    await ageStatus(order.id, OrderStatus.UNDERPAID, 10_000);

    const summary = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(summary).toMatchObject({ underpaidResolved: 0, underpaidNeedsAdmin: 0, underpaidErrored: 0 });
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);
    expect(await walletIdr()).toBe("9");
    expect(await reservedFor(order.id)).toBe(1);
    expect(await reviewAlerts(order.id)).toHaveLength(0);
  });

  it("resolves an UNDERPAID order past a 72h limit: received amount credited once, every hold released", async () => {
    const order = await makeUnderpaidQrisOrder("2");
    await ageStatus(order.id, OrderStatus.UNDERPAID, 73);
    expect(await walletIdr()).toBe("9");
    expect(await reservedFor(order.id)).toBe(1);

    const summary = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(summary.underpaidResolved).toBe(1);
    expect(await statusOf(order.id)).toBe(OrderStatus.REFUNDED);
    // 9 left after checkout + 1 wallet credit returned + 2 that actually arrived.
    expect(await walletIdr()).toBe("12");
    const refundRows = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } });
    expect(refundRows).toHaveLength(1);
    expect(new Decimal(refundRows[0]!.delta).toString()).toBe("2");
    expect(refundRows[0]!.currency).toBe("IDR");
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "order_refund" } })).toBe(1);
    // Stock back in the pool, voucher use and redemption rolled back.
    expect(await reservedFor(order.id)).toBe(0);
    expect(await prisma.stockItem.count({ where: { productId: sample.product.id, status: StockStatus.AVAILABLE } })).toBe(5);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: sample.voucher.id } })).usedCount).toBe(0);
    expect(await prisma.voucherRedemption.count({ where: { voucherId: sample.voucher.id } })).toBe(0);
    // A Refund record and a system audit line (no acting admin).
    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
    expect(new Decimal(refunds[0]!.amount).toString()).toBe("2");
    const audit = await prisma.auditLog.findMany({ where: { targetId: order.id, action: "underpaid_auto_refund" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminId).toBeNull();
    expect(audit[0]!.details).toMatch(/2 IDR/);
  });

  it("leaves an UNDERPAID order younger than the TTL untouched", async () => {
    const order = await makeUnderpaidQrisOrder();
    await ageStatus(order.id, OrderStatus.UNDERPAID, 71);

    const summary = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(summary.underpaidResolved).toBe(0);
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);
    expect(await walletIdr()).toBe("9");
    expect(await reservedFor(order.id)).toBe(1);
    expect(await reviewAlerts(order.id)).toHaveLength(0);
  });

  it("honours the owner's TTL setting, and '0' disables auto-resolution entirely", async () => {
    const order = await makeUnderpaidQrisOrder();
    await ageStatus(order.id, OrderStatus.UNDERPAID, 5);

    await setSetting(prisma, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, "0");
    expect((await sweepAgedUnderpaidAndFailedOrders(prisma, NOW)).underpaidResolved).toBe(0);
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);

    await setSetting(prisma, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, "4");
    expect((await sweepAgedUnderpaidAndFailedOrders(prisma, NOW)).underpaidResolved).toBe(1);
    expect(await statusOf(order.id)).toBe(OrderStatus.REFUNDED);
  });

  it("is idempotent: a second run credits nothing more", async () => {
    const order = await makeUnderpaidQrisOrder("2");
    await ageStatus(order.id, OrderStatus.UNDERPAID, 100);

    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    const second = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(second.underpaidResolved).toBe(0);
    expect(await walletIdr()).toBe("12");
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "underpaid_refund" } })).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "order_refund" } })).toBe(1);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    // A second direct attempt on the resolved order is a clean no-op too.
    expect((await autoResolveExpiredUnderpaidOrder(prisma, order.id, { now: NOW, ttlHours: 72 })).kind).toBe("skipped");
  });

  it("two sweeps racing on one order credit it exactly once", async () => {
    const order = await makeUnderpaidQrisOrder("2");
    await ageStatus(order.id, OrderStatus.UNDERPAID, 100);

    const results = await Promise.all([
      autoResolveExpiredUnderpaidOrder(prisma, order.id, { now: NOW, ttlHours: 72 }),
      autoResolveExpiredUnderpaidOrder(prisma, order.id, { now: NOW, ttlHours: 72 }),
    ]);

    expect(results.map((r) => r.kind).sort()).toEqual(["resolved", "skipped"]);
    expect(await walletIdr()).toBe("12");
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "underpaid_refund" } })).toBe(1);
  });

  it("a resolution that commits while the sweep waits for the order row wins; the sweep changes nothing", async () => {
    const order = await makeUnderpaidQrisOrder("2");
    await ageStatus(order.id, OrderStatus.UNDERPAID, 100);

    let sweep: Promise<unknown> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${order.id} FOR NO KEY UPDATE`;
      // An admin's "deliver anyway" moves it on while holding the row.
      await transitionOrderStatus(tx, { orderId: order.id, from: OrderStatus.UNDERPAID, to: OrderStatus.PENDING_VERIFICATION });
      sweep = autoResolveExpiredUnderpaidOrder(prisma, order.id, { now: NOW, ttlHours: 72 });
      await new Promise((r) => setTimeout(r, 400));
    }, { timeout: 15000 });

    expect(await sweep).toMatchObject({ kind: "skipped" });
    expect(await statusOf(order.id)).toBe(OrderStatus.PENDING_VERIFICATION);
    expect(await walletIdr()).toBe("9");
    expect(await reservedFor(order.id)).toBe(1);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "underpaid_refund" } })).toBe(0);
  });

  it("credits a USDT order in USDT (Binance Internal rail)", async () => {
    const created = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({
      where: { id: created.id },
      data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL, currency: "USDT", fxRate: "16000" },
    });
    expect(await markUnderpaid(prisma, { orderId: created.id, binanceTxId: "tx-a4-usdt", amount: "0.15" })).toBe(true);
    await ageStatus(created.id, OrderStatus.UNDERPAID, 100);

    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalanceUsdt).toString()).toBe("0.15");
    expect(new Decimal(buyer.walletBalance).toString()).toBe("0");
    expect(await statusOf(created.id)).toBe(OrderStatus.REFUNDED);
    expect(await reservedFor(created.id)).toBe(0);
  });

  it("never releases a Digiflazz order the supplier may still complete; raises one admin alert instead", async () => {
    const order = await makeUnderpaidQrisOrder();
    await prisma.order.update({
      where: { id: order.id },
      data: { fulfillmentProvider: "DIGIFLAZZ", digiflazzDispatchedAt: new Date(NOW.getTime() - 80 * HOUR), digiflazzStatus: "pending_at_supplier" },
    });
    await ageStatus(order.id, OrderStatus.UNDERPAID, 100);

    const first = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(first.underpaidResolved).toBe(0);
    expect(first.underpaidNeedsAdmin).toBe(1);
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);
    expect(await walletIdr()).toBe("9");
    expect(await reservedFor(order.id)).toBe(1);
    expect(await reviewAlerts(order.id)).toHaveLength(1);
  });

  it("leaves an UNDERPAID order with no recorded received amount for an admin, alerting once", async () => {
    const created = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await transitionOrderStatus(prisma, { orderId: created.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.UNDERPAID });
    await ageStatus(created.id, OrderStatus.UNDERPAID, 100);

    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(await statusOf(created.id)).toBe(OrderStatus.UNDERPAID);
    expect(await reservedFor(created.id)).toBe(1);
    expect(await reviewAlerts(created.id)).toHaveLength(1);
  });

  it("leaves an UNDERPAID wallet top-up for an admin (its fee rules need a human), alerting once", async () => {
    const topup = await createWalletTopupOrder(prisma, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY });
    expect(topup.kind).toBe(OrderKind.WALLET_TOPUP);
    await markOrderUnderpaid(prisma, { orderId: topup.id, gateway: "TOKOPAY", receivedAmount: "5000", expectedAmount: topup.totalAmount });
    expect(await statusOf(topup.id)).toBe(OrderStatus.UNDERPAID);
    await ageStatus(topup.id, OrderStatus.UNDERPAID, 100);

    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(await statusOf(topup.id)).toBe(OrderStatus.UNDERPAID);
    expect(await prisma.walletTransaction.count({ where: { orderId: topup.id } })).toBe(0);
    expect(await reviewAlerts(topup.id)).toHaveLength(1);
  });

  it("leaves an UNDERPAID order that is marked paid for an admin (refunding part could be wrong), alerting once", async () => {
    const order = await makeUnderpaidQrisOrder();
    await prisma.order.update({ where: { id: order.id }, data: { paidAt: new Date(NOW.getTime() - 90 * HOUR) } });
    await ageStatus(order.id, OrderStatus.UNDERPAID, 100);

    const direct = await autoResolveExpiredUnderpaidOrder(prisma, order.id, { now: NOW, ttlHours: 72 });
    expect(direct).toMatchObject({ kind: "needs_admin", reason: "looks_paid" });
    const summary = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(summary).toMatchObject({ underpaidResolved: 0, underpaidNeedsAdmin: 1, underpaidErrored: 0 });
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);
    expect(await walletIdr()).toBe("9");
    expect(await reservedFor(order.id)).toBe(1);
    expect(await reviewAlerts(order.id)).toHaveLength(1);
  });

  it("with no admin configured: still refunds what it safely can, queues no alert, and leaves the rest untouched", async () => {
    const cfg = config as unknown as { ADMIN_IDS: number[] };
    const saved = cfg.ADMIN_IDS;
    cfg.ADMIN_IDS = [];
    try {
      const resolvable = await makeUnderpaidQrisOrder("2");
      await ageStatus(resolvable.id, OrderStatus.UNDERPAID, 100);
      const topup = await createWalletTopupOrder(prisma, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY });
      await markOrderUnderpaid(prisma, { orderId: topup.id, gateway: "TOKOPAY", receivedAmount: "5000", expectedAmount: topup.totalAmount });
      await ageStatus(topup.id, OrderStatus.UNDERPAID, 100);
      const failed = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
      await transitionOrderStatus(prisma, { orderId: failed.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.FAILED });
      await ageStatus(failed.id, OrderStatus.FAILED, 100);

      const summary = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

      expect(summary).toEqual({ underpaidResolved: 1, underpaidNeedsAdmin: 1, underpaidErrored: 0, failedAlerted: 0 });
      expect(await statusOf(resolvable.id)).toBe(OrderStatus.REFUNDED);
      expect(await statusOf(topup.id)).toBe(OrderStatus.UNDERPAID);
      expect(await statusOf(failed.id)).toBe(OrderStatus.FAILED);
      expect(await prisma.notificationOutbox.count({ where: { event: NotificationEvent.ORDER_PIPELINE_FAILED } })).toBe(0);
    } finally {
      cfg.ADMIN_IDS = saved;
    }
  });

  it("an alert that cannot be queued is not counted as a failed resolution", async () => {
    const created = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await transitionOrderStatus(prisma, { orderId: created.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.UNDERPAID });
    await ageStatus(created.id, OrderStatus.UNDERPAID, 100);
    // The deduped enqueue is the only raw INSERT the sweep runs on the bare
    // client (the resolution runs on its own transaction client); fail just it.
    const original = prisma.$queryRaw.bind(prisma) as (q: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>;
    const spy = vi.spyOn(prisma, "$queryRaw").mockImplementation(((query: TemplateStringsArray, ...values: unknown[]) => {
      if (query.join("?").includes("INSERT INTO notification_outbox")) return Promise.reject(new Error("outbox down"));
      return original(query, ...values);
    }) as unknown as typeof prisma.$queryRaw);
    try {
      const summary = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
      expect(summary).toMatchObject({ underpaidNeedsAdmin: 1, underpaidErrored: 0 });
      expect(await statusOf(created.id)).toBe(OrderStatus.UNDERPAID);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("sweepAgedUnderpaidAndFailedOrders — setting values", () => {
  it("treats an invalid value as off and warns about it once per process, not every run", async () => {
    const order = await makeUnderpaidQrisOrder();
    await ageStatus(order.id, OrderStatus.UNDERPAID, 100);
    await setSetting(prisma, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, "72h-typo");
    const warn = vi.spyOn(logger, "warn");
    try {
      await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
      await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
      const about = warn.mock.calls.filter((c) => c.some((a) => typeof a === "string" && a.includes(UNDERPAID_AUTO_RESOLVE_HOURS_KEY)));
      expect(about).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);
  });

  it('"00" means off, never "refund immediately"', async () => {
    const order = await makeUnderpaidQrisOrder();
    await ageStatus(order.id, OrderStatus.UNDERPAID, 1);
    await setSetting(prisma, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, "00");
    expect((await sweepAgedUnderpaidAndFailedOrders(prisma, NOW)).underpaidResolved).toBe(0);
    expect(await statusOf(order.id)).toBe(OrderStatus.UNDERPAID);
  });
});

describe("sweepAgedUnderpaidAndFailedOrders — FAILED orders are alert-only", () => {
  async function makeFailedOrder() {
    const created = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await transitionOrderStatus(prisma, { orderId: created.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.FAILED });
    return created;
  }

  it("raises one aging alert for a FAILED order past the alert window and changes nothing about it", async () => {
    const order = await makeFailedOrder();
    await ageStatus(order.id, OrderStatus.FAILED, 25);
    const before = await prisma.walletTransaction.count();

    const first = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    const second = await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);

    expect(first.failedAlerted).toBe(1);
    expect(second.failedAlerted).toBe(0);
    expect(await statusOf(order.id)).toBe(OrderStatus.FAILED);
    expect(await reservedFor(order.id)).toBe(1);
    expect(await prisma.walletTransaction.count()).toBe(before);
    const alerts = await reviewAlerts(order.id);
    expect(alerts).toHaveLength(1);
    expect(JSON.parse(alerts[0]!.payloadJson).chat_id).toBe(444);
  });

  it("does not alert for a FAILED order inside the alert window, and '0' turns the alert off", async () => {
    const order = await makeFailedOrder();
    await ageStatus(order.id, OrderStatus.FAILED, 23);
    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    expect(await reviewAlerts(order.id)).toHaveLength(0);

    await ageStatus(order.id, OrderStatus.FAILED, 500);
    await setSetting(prisma, FAILED_ORDER_ALERT_HOURS_KEY, "0");
    await sweepAgedUnderpaidAndFailedOrders(prisma, NOW);
    expect(await reviewAlerts(order.id)).toHaveLength(0);
  });
});
