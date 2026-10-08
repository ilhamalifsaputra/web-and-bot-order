/**
 * The Digiflazz fulfilment paths register the buyer's progress message through
 * the one shared helper (`ensureFulfillmentMessage` in ./fulfillmentMessages),
 * not a private copy: one idempotent upsert (`update: {}`), so a later phase
 * reuses the row, and therefore the Telegram message, created earlier.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect } from "./orders";
import { fulfillDigiflazzOrder } from "./digiflazz";
import { DeliveryType, OrderStatus } from "@app/core/enums";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;

beforeAll(async () => { db = await makeTestDb(); prisma = db.prisma; });
afterAll(async () => { await db.cleanup(); });
beforeEach(async () => { await resetDb(prisma); sample = await buildSampleData(prisma); });

async function processingDigiflazzOrder(user = sample.user) {
  await prisma.denomination.update({
    where: { id: sample.product.id },
    data: {
      autoDeliverySource: "digiflazz",
      supplierSku: "ml100",
      deliveryType: DeliveryType.MANUAL_WITH_INFO,
      additionalFields: JSON.stringify([
        { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
      ]),
    },
  });
  const order = (await createOrderDirect(prisma, {
    channel: "bot", user, productId: sample.product.id, quantity: 1, customerData: JSON.stringify([{ user_id: "123456789" }]),
  }))!;
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
  return order;
}

describe("Digiflazz uses the shared progress-message helper", () => {
  it("has no private copy of ensureFulfillmentMessage", () => {
    const source = readFileSync(new URL("./digiflazz.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/function\s+ensureFulfillmentMessage\b/);
    expect(source).toMatch(/import\s*\{[^}]*\bensureFulfillmentMessage\b[^}]*\}\s*from\s*"\.\/fulfillmentMessages"/);
  });

  it("reuses the existing row (and its sent message) when the order is fulfilled", async () => {
    const order = await processingDigiflazzOrder();
    await prisma.fulfillmentMessage.update({ where: { orderId: order.id }, data: { chatId: 42n, messageId: 77, state: "ACTIVE" } });
    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-1" });
    const rows = await prisma.fulfillmentMessage.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ messageId: 77, state: "ACTIVE" });
  });

  it("creates the row for a Telegram buyer that had none, and none for a web-only buyer", async () => {
    const order = await processingDigiflazzOrder();
    await prisma.fulfillmentMessage.deleteMany({ where: { orderId: order.id } });
    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-2" });
    expect(await prisma.fulfillmentMessage.findMany({ where: { orderId: order.id } })).toHaveLength(1);

    const webUser = await prisma.user.create({ data: { referralCode: `web-${Math.random()}` } });
    const webOrder = await processingDigiflazzOrder(webUser);
    await fulfillDigiflazzOrder(prisma, webOrder.id, { sn: "SN-3" });
    expect(await prisma.fulfillmentMessage.count({ where: { orderId: webOrder.id } })).toBe(0);
  });
});
