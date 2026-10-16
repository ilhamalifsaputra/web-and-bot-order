// setup-db MUST be first — temp DB + push before any @app import.
import "./setup-db";

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Api } from "grammy";
import { Decimal } from "@app/core/money";
import { NotificationEvent, OrderStatus, PaymentMethod, StockStatus } from "@app/core/enums";
import {
  prisma,
  createOrderDirect,
  markOrderUnderpaid,
  transitionOrderStatus,
  setSetting,
  UNDERPAID_AUTO_RESOLVE_HOURS_KEY,
  __clearSettingsCacheForTests,
} from "@app/db";
import { buildSampleData, resetDb, type SampleData } from "../../../tests/helpers/sampleData";
import { resolveAgedUnderpaidAndFailedOrders } from "../src/jobs";

/**
 * The scheduled wrapper for backend audit A4: it must run the real sweep
 * (refund aged UNDERPAID orders once the owner switched it on, alert on aged
 * FAILED ones) and never talk to Telegram itself — everything it causes goes
 * through the outbox.
 */

let sample: SampleData;
const HOUR = 3_600_000;

/** A bot Api that records any use; the job must not touch it. */
function untouchableApi(): { api: Api; used: string[] } {
  const used: string[] = [];
  const api = new Proxy({}, { get: (_t, prop) => { used.push(String(prop)); return () => Promise.resolve({}); } }) as Api;
  return { api, used };
}

beforeEach(async () => {
  await resetDb(prisma);
  __clearSettingsCacheForTests(prisma);
  sample = await buildSampleData(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function agedUnderpaidOrder() {
  const order = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  await prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.TOKOPAY, currency: "IDR" } });
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  expect(await markOrderUnderpaid(prisma, { orderId: order.id, gateway: "TOKOPAY", receivedAmount: "2", expectedAmount: fresh.totalAmount })).toBe(true);
  await prisma.orderStatusHistory.updateMany({
    where: { orderId: order.id, status: OrderStatus.UNDERPAID },
    data: { occurredAt: new Date(Date.now() - 100 * HOUR) },
  });
  return order;
}

describe("resolveAgedUnderpaidAndFailedOrders (scheduled job)", () => {
  it("does nothing to an aged UNDERPAID order while the owner has not switched auto-refund on", async () => {
    const order = await agedUnderpaidOrder();
    const { api, used } = untouchableApi();

    await resolveAgedUnderpaidAndFailedOrders(api);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.UNDERPAID);
    expect(await prisma.stockItem.count({ where: { orderId: order.id, status: StockStatus.RESERVED } })).toBe(1);
    expect(used).toEqual([]);
  });

  it("once switched on, refunds the aged order, releases its stock and alerts on an aged FAILED order, without touching Telegram", async () => {
    await setSetting(prisma, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, "72");
    const order = await agedUnderpaidOrder();
    const failed = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await transitionOrderStatus(prisma, { orderId: failed.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.FAILED });
    await prisma.orderStatusHistory.updateMany({
      where: { orderId: failed.id, status: OrderStatus.FAILED },
      data: { occurredAt: new Date(Date.now() - 30 * HOUR) },
    });
    const { api, used } = untouchableApi();

    await resolveAgedUnderpaidAndFailedOrders(api);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.REFUNDED);
    expect(await prisma.stockItem.count({ where: { orderId: order.id, status: StockStatus.RESERVED } })).toBe(0);
    const credit = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } });
    expect(credit.map((c) => new Decimal(c.delta).toString())).toEqual(["2"]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe(OrderStatus.FAILED);
    // ADMIN_IDS is "999,1000" (test/setup-db.ts): one alert per admin.
    expect(await prisma.notificationOutbox.count({ where: { orderId: failed.id, event: NotificationEvent.ORDER_PIPELINE_FAILED } })).toBe(2);
    expect(used).toEqual([]);

    // A second scheduled run changes nothing more.
    await resolveAgedUnderpaidAndFailedOrders(api);
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id, reason: "underpaid_refund" } })).toBe(1);
    expect(await prisma.notificationOutbox.count({ where: { orderId: failed.id, event: NotificationEvent.ORDER_PIPELINE_FAILED } })).toBe(2);
  });
});
