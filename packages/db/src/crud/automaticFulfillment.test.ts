import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { createOrderDirect, createOrderFromCart, attachPaymentProof, settlePaidOrder, updateOrderCustomerData, fulfillManualOrder } from "./orders";
import { bulkAddStock } from "./stock";
import { dispatchPendingDigiflazzOrders, recordDigiflazzOutcome, fulfillDigiflazzOrder } from "./digiflazz";
import { setSetting } from "./settings";
import { addAdminIdToDb } from "./admins";
import { NotificationEvent } from "@app/core/enums";

const supplier = vi.hoisted(() => ({ createTransaction: vi.fn() }));
const alertFault = vi.hoisted(() => ({ fail: false }));
vi.mock("./notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notifications")>();
  return { ...actual, enqueueDigiflazzReviewAlert: async (...args: Parameters<typeof actual.enqueueDigiflazzReviewAlert>) => {
    if (alertFault.fail) throw new Error("simulated outbox failure");
    return actual.enqueueDigiflazzReviewAlert(...args);
  } };
});
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...await importOriginal<typeof import("@app/core/suppliers/digiflazz")>(),
  createTransaction: supplier.createTransaction,
}));

let db: TestDb;
let sample: SampleData;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await resetDb(db.prisma);
  sample = await buildSampleData(db.prisma);
  supplier.createTransaction.mockReset();
  alertFault.fail = false;
  await setSetting(db.prisma, "digiflazz_username", "test-buyer");
  await setSetting(db.prisma, "digiflazz_api_key", "test-api-key");
  await addAdminIdToDb(db.prisma, 987654321);
  await db.prisma.denomination.update({ where: { id: sample.product.id }, data: {
    deliveryType: "manual_with_info", autoDeliverySource: "digiflazz", supplierSku: "ML5",
    additionalFields: JSON.stringify([{ key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" }]),
  } });
});

async function paidOrder() {
  const order = await createOrderDirect(db.prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1, customerData: JSON.stringify([{ game_id: "12345" }]) });
  await attachPaymentProof(db.prisma, order!.id, { fileId: "proof", txid: "payment-1" });
  await db.prisma.$transaction(tx => settlePaidOrder(tx, order!.id, { adminId: sample.user.id }));
  return (await db.prisma.order.findUniqueOrThrow({ where: { id: order!.id }, include: { items: { include: { product: true } } } }));
}

describe("automatic fulfillment routing", () => {
  it("rejects mixed supplier and stock carts before reserving stock or creating an order", async () => {
    await db.prisma.denomination.update({ where: { id: sample.product.id }, data: { deliveryType: "auto" } });
    const stockSku = await db.prisma.denomination.create({ data: { productId: sample.product.productId, slug: "stock-sku", name: "Stock SKU", type: "SHARED", durationLabel: "", price: "1000", deliveryType: "auto" } });
    await bulkAddStock(db.prisma, stockSku.id, ["stock receipt"]);
    await db.prisma.cartItem.createMany({ data: [{ userId: sample.user.id, productId: sample.product.id, quantity: 1 }, { userId: sample.user.id, productId: stockSku.id, quantity: 1 }] });
    await expect(db.prisma.$transaction(tx => createOrderFromCart(tx, { channel: "bot", user: sample.user, customerData: JSON.stringify([{ game_id: "12345" }]) }))).rejects.toThrow("error.cart_mixed_delivery");
    expect(await db.prisma.order.count()).toBe(0);
    expect(await db.prisma.stockItem.count({ where: { status: "RESERVED" } })).toBe(0);
  });
  it("keeps delivery retryable when persisting item completion fails", async () => {
    const order = await paidOrder();
    await db.prisma.$executeRawUnsafe("CREATE FUNCTION reject_item_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated item persistence failure'; END $$");
    await db.prisma.$executeRawUnsafe("CREATE TRIGGER reject_item_delivery BEFORE UPDATE OF status ON order_items FOR EACH ROW EXECUTE FUNCTION reject_item_delivery()");
    try {
      await expect(fulfillDigiflazzOrder(db.prisma, order.id, { sn: "receipt" })).rejects.toThrow("simulated item persistence failure");
      expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PROCESSING");
    } finally {
      await db.prisma.$executeRawUnsafe("DROP TRIGGER reject_item_delivery ON order_items");
      await db.prisma.$executeRawUnsafe("DROP FUNCTION reject_item_delivery()");
    }
    await fulfillDigiflazzOrder(db.prisma, order.id, { sn: "receipt" });
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DELIVERED");
  });
  it("routes explicit supplier products without requiring local stock", async () => {
    await db.prisma.denomination.update({ where: { id: sample.product.id }, data: { deliveryType: "auto" } });
    const order = await createOrderDirect(db.prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1, customerData: JSON.stringify([{ game_id: "12345" }]) });
    expect(order?.fulfillmentProvider).toBe("DIGIFLAZZ");
    expect(order?.items[0]?.stockItemId).toBeNull();
  });
  it("queues a paid Digiflazz order without manual/admin notifications", async () => {
    const order = await paidOrder();
    expect(order.status).toBe("PROCESSING");
    expect(order.paidAt).not.toBeNull();
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id, event: { in: [NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED, NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED, NotificationEvent.ORDER_PROCESSING_DM] } } })).toBe(0);
    await expect(db.prisma.$transaction(tx => settlePaidOrder(tx, order.id, { adminId: sample.user.id }))).rejects.toThrow();
  });

  it("retains the purchased supplier SKU and provider after a catalog edit", async () => {
    const order = await paidOrder();
    await db.prisma.denomination.update({ where: { id: sample.product.id }, data: { autoDeliverySource: null, supplierSku: "WRONG-SKU" } });
    supplier.createTransaction.mockResolvedValue({ status: "Sukses", sn: "receipt" });
    const result = await dispatchPendingDigiflazzOrders(db.prisma);
    expect(result.delivered).toBe(1);
    expect(supplier.createTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ buyerSkuCode: "ML5", refId: order.orderCode }));
    expect(await db.prisma.orderItem.findMany({ where: { orderId: order.id } })).toEqual([expect.objectContaining({ status: "DELIVERED" })]);
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id, event: NotificationEvent.ORDER_MANUAL_DELIVERED_DM } })).toBe(0);
  });

  it("blocks target edits once the supplier request has been claimed", async () => {
    const order = await paidOrder();
    await db.prisma.order.update({ where: { id: order.id }, data: { digiflazzDispatchedAt: new Date(), digiflazzStatus: "pending_at_supplier" } });
    await expect(updateOrderCustomerData(db.prisma, order.id, [{ game_id: "different" }])).rejects.toThrow();
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).customerData).toContain("12345");
  });

  it("alerts once when terminal failure is repeated", async () => {
    const order = await paidOrder();
    await db.prisma.notificationOutbox.deleteMany({ where: { orderId: order.id } });
    await recordDigiflazzOutcome(db.prisma, order, { kind: "terminal", reason: "provider rejected", supplierGaveReason: true }, new Date());
    await recordDigiflazzOutcome(db.prisma, order, { kind: "terminal", reason: "provider rejected", supplierGaveReason: true }, new Date());
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(1);
    expect((await db.prisma.notificationOutbox.findFirstOrThrow({ where: { orderId: order.id } })).event).toBe(NotificationEvent.ORDER_PIPELINE_FAILED);
  });

  it("does not allow hand-delivery while automatic fulfillment is in flight", async () => {
    const order = await paidOrder();
    await expect(fulfillManualOrder(db.prisma, order.id, { adminId: sample.user.id, content: "manual" })).rejects.toThrow();
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PROCESSING");
  });

  it("alerts once if captured payment cannot start without provider credentials", async () => {
    const order = await paidOrder();
    await setSetting(db.prisma, "digiflazz_api_key", "");
    await dispatchPendingDigiflazzOrders(db.prisma);
    await dispatchPendingDigiflazzOrders(db.prisma);
    expect(supplier.createTransaction).not.toHaveBeenCalled();
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).digiflazzStatus).toBe("failed");
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id, event: NotificationEvent.ORDER_PIPELINE_FAILED } })).toBe(1);
  });

  it("simultaneous dispatchers submit one canonical transaction", async () => {
    await paidOrder();
    supplier.createTransaction.mockResolvedValue({ status: "Pending" });
    await Promise.all([dispatchPendingDigiflazzOrders(db.prisma), dispatchPendingDigiflazzOrders(db.prisma)]);
    expect(supplier.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("keeps a terminal incident retryable if its durable alert cannot be recorded", async () => {
    const order = await paidOrder();
    alertFault.fail = true;
    await expect(recordDigiflazzOutcome(db.prisma, order, { kind: "terminal", reason: "provider rejected", supplierGaveReason: true }, new Date())).rejects.toThrow("outbox failure");
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).digiflazzStatus).toBeNull();
    alertFault.fail = false;
    await recordDigiflazzOutcome(db.prisma, order, { kind: "terminal", reason: "provider rejected", supplierGaveReason: true }, new Date());
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: order.id, event: NotificationEvent.ORDER_PIPELINE_FAILED } })).toBe(1);
  });
});
