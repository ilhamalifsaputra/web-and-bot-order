/**
 * Delivery-path tests for `deliverPaidInternalOrder` — the Binance Internal
 * Transfer analogue of crud/tokopay.test.ts's deliverPaidTokopayOrder suite.
 *
 * Overpayment (M-13, backend audit 2026-07-31): TokoPay/PayDisini/NOWPayments
 * already flag `outcome: "overpaid"` + enqueue an ADMIN_OVERPAID alert when
 * the buyer sent more than the order total. Binance Internal delivered
 * correctly on overpayment (its match tolerance allows it) but never flagged
 * it — this file's "overpaid" test pins the fix.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [444] } };
});

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, deliverPaidInternalOrder, createCategory, createCatalogProduct, createDenomination } from "@app/db";
import { OrderStatus, PaymentMethod, NotificationEvent, DeliveryType } from "@app/core/enums";
import { Decimal } from "@app/core/money";

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

/** Create a PENDING_PAYMENT order stamped as a Binance Internal Transfer payment. */
async function makePendingInternalOrder() {
  const { user, product } = sample;
  const order = (await createOrderDirect(prisma, { user, productId: product.id, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
  });
  return order;
}

/** Same as makePendingInternalOrder, but for a caller-supplied denomination
 * (used to route through a manual-delivery SKU instead of sample.product). */
async function makePendingInternalOrderFor(productId: number) {
  const { user } = sample;
  const order = (await createOrderDirect(prisma, { user, productId, quantity: 1 }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
  });
  return order;
}

/** A manual (no-stock) denomination, on its own category/product. */
async function makeManualDenom() {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
  return createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
    warrantyDays: 30,
    deliveryType: DeliveryType.MANUAL,
  });
}

describe("deliverPaidInternalOrder", () => {
  it("delivers a pending order and claims the tx id", async () => {
    const order = await makePendingInternalOrder();

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-delivered-1",
      amount: order.totalAmount,
    });

    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);
    expect(result.credentials.length).toBe(1);

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-delivered-1" } });
    expect(ledgerRow?.outcome).toBe("matched");
    expect(ledgerRow?.orderId).toBe(order.id);
  });

  it("paying exactly the order total is NOT flagged overpaid", async () => {
    const order = await makePendingInternalOrder();

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-exact-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("delivered");

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-exact-1" } });
    expect(ledgerRow?.outcome).toBe("matched"); // not "overpaid"

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(0);
  });

  // M-13 (backend audit 2026-07-31): Binance Internal's match tolerance lets an
  // overpaid transfer through to delivery, but it used to leave no ledger flag
  // and no admin alert — the surplus had no operational trail for a later
  // refund request. Mirrors the TokoPay overpaid test (crud/tokopay.test.ts).
  it("overpaid: delivers, ledger outcome is overpaid, and enqueues an ADMIN_OVERPAID row with correct excess/currency", async () => {
    const order = await makePendingInternalOrder();
    const paid = new Decimal(order.totalAmount).plus("3"); // overpay by 3 USDT

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-overpaid-1",
      amount: paid,
    });
    expect(result.status).toBe("delivered");
    if (result.status !== "delivered") throw new Error("expected delivered");

    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-overpaid-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1); // one ADMIN_IDS entry ([444])
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.chat_id).toBe(444);
    expect(payload.order_code).toBe(result.order.orderCode);
    expect(payload.paid).toBe(paid.toString());
    expect(payload.expected).toBe(new Decimal(order.totalAmount).toString());
    expect(payload.excess).toBe("3");
    expect(payload.currency).toBe(result.order.currency);
  });

  it("a repeated tx id is already_processed (no double-delivery)", async () => {
    const order = await makePendingInternalOrder();

    const first = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-dup-1",
      amount: order.totalAmount,
    });
    expect(first.status).toBe("delivered");

    const second = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-dup-1",
      amount: order.totalAmount,
    });
    expect(second.status).toBe("already_processed");

    const rows = await prisma.processedBinanceTx.findMany({ where: { binanceTxId: "tx-dup-1" } });
    expect(rows.length).toBe(1);
  });

  it("an order that is no longer PENDING_PAYMENT is stale", async () => {
    const order = await makePendingInternalOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-stale-1",
      amount: order.totalAmount,
    });
    expect(result.status).toBe("stale");
  });

  // M-35 (backend audit 2026-07-31): the "processing" branch (manual-delivery
  // SKUs, settlePaidOrder's non-AUTO path) had no test at all — including
  // whether the overpaid ledger flag/admin alert (which stays unconditional,
  // per the code comment) actually still fires when the order queues for hand
  // fulfilment instead of auto-delivering.
  it("processing (manual SKU): kind stays processing, no stock is touched, and the overpaid alert still fires unconditionally", async () => {
    const manualDenom = await makeManualDenom();
    const order = await makePendingInternalOrderFor(manualDenom.id);
    const expectedTotal = new Decimal(order.totalAmount);
    const paid = expectedTotal.plus("2"); // overpay by 2 USDT

    const result = await deliverPaidInternalOrder(prisma, {
      orderId: order.id,
      binanceTxId: "tx-processing-1",
      amount: paid,
    });

    expect(result.status).toBe("processing");
    if (result.status !== "processing") throw new Error("expected processing");
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    // Manual SKUs never reserve stock.
    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);

    // Overpayment is orthogonal to delivery type — the ledger flag and admin
    // alert must still fire even though this order queued for hand fulfilment.
    const ledgerRow = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "tx-processing-1" } });
    expect(ledgerRow?.outcome).toBe("overpaid");
    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_OVERPAID },
    });
    expect(adminRows.length).toBe(1);
    const payload = JSON.parse(adminRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.excess).toBe("2");

    // settlePaidOrder's own buyer "being prepared" DM went out for the manual queue.
    const processingDm = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(processingDm).not.toBeNull();
  });
});
