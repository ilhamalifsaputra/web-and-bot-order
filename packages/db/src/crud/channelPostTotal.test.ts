/**
 * B8 (money audit): the public channel "order delivered" post prints what the
 * order was worth, not what was left to collect after wallet credit, and
 * without the unique-cents matching noise.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, finalizeOrderPayment, getOrder } from "@app/db";
import { finalizeDeliverySideEffects } from "./orders";
import { createDenomination } from "./catalog";
import { NotificationEvent, OrderCurrency } from "@app/core/enums";
import { setBotIdentity, resetBotIdentity } from "@app/core/runtime";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => {
  db = await makeTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  resetBotIdentity();
  await db.cleanup();
});
beforeEach(async () => {
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  setBotIdentity({ publicChannelId: -100123 });
});

async function newOrder() {
  const sku = await createDenomination(prisma, {
    productId: sample.parentProduct.id,
    name: "SKU 15500",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "15500",
    deliveryType: "manual",
  });
  const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sku.id, quantity: 1 });
  return order!;
}

async function postedTotal(orderId: number) {
  const order = await getOrder(prisma, orderId);
  await finalizeDeliverySideEffects(prisma, order!, new Date());
  const row = await prisma.notificationOutbox.findFirstOrThrow({
    where: { orderId, event: NotificationEvent.ORDER_DELIVERED },
  });
  const payload = JSON.parse(row.payloadJson) as { total: string; currency: string };
  return payload;
}

describe("public channel ORDER_DELIVERED total", () => {
  it("a gateway-paid IDR order posts its whole-rupiah total", async () => {
    const order = await newOrder();
    await finalizeOrderPayment(prisma, order.id, { currency: OrderCurrency.IDR });
    expect(await postedTotal(order.id)).toMatchObject({ total: "15500", currency: "IDR" });
  });

  it("a wallet-paid IDR order posts the amount paid from the balance, not 0", async () => {
    const order = await newOrder();
    await prisma.order.update({
      where: { id: order.id },
      data: { currency: "IDR", walletUsed: "15500", totalAmount: "0", uniqueCents: "0" },
    });
    expect(await postedTotal(order.id)).toMatchObject({ total: "15500", currency: "IDR" });
  });

  it("a USDT order posts its price without the unique cents (and gross of USDT credit)", async () => {
    const order = await newOrder();
    // 15.500 / 16.000 = 0.96875 -> 0.97 USDT, + 0.0066 unique cents, 0.5 paid from USDT credit.
    await prisma.order.update({
      where: { id: order.id },
      data: { currency: "USDT", fxRate: "16000", uniqueCents: "0.0066", walletUsed: "0.5", totalAmount: "0.4766" },
    });
    expect(await postedTotal(order.id)).toMatchObject({ total: "0.97", currency: "USDT" });
  });
});
