/**
 * Tests for the per-SKU delivery-flow core added on top of the pre-existing
 * approveOrder/createOrderDirect/createOrderFromCart: settlePaidOrder (the
 * auto/manual branch point), fulfillManualOrder (admin hand-fulfilment),
 * the manual-skip stock paths in createOrderDirect, LEGAL_TRANSITIONS'
 * PROCESSING state, and the pure @app/core/deliveryFields validator.
 *
 * See .superpowers/sdd/dlv-task-2-brief.md for the plan this covers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  settlePaidOrder,
  fulfillManualOrder,
  createOrderDirect,
  attachPaymentProof,
  updateOrderCustomerData,
} from "./orders";
import { createCategory, createCatalogProduct, createDenomination, updateDenomination } from "./catalog";
import { LEGAL_TRANSITIONS, transitionOrderStatus } from "./orderStatus";
import { DeliveryType, OrderStatus, NotificationEvent, StockStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import {
  validateFieldAnswer,
  AdditionalFieldType,
  type AdditionalField,
} from "@app/core/deliveryFields";
import { setSetting } from "./settings";
import { addAdminIdToDb } from "./admins";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
/** logAdminAction's AuditLog.adminId carries a real FK to User (unlike
 * WalletTransaction.adminId, which is a plain nullable Int) — fulfillManualOrder
 * always audits, so tests exercising it need an adminId that resolves to an
 * actual row, not an arbitrary literal. */
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
      telegramId: BigInt(900_000_000 + Math.floor(Math.random() * 1_000_000)),
      referralCode: `admin-${Math.random()}`,
      role: "ADMIN",
    },
  });
  adminId = admin.id;
});

/** A manual (or manual_with_info) denomination with NO stock rows, using the
 * same category/product created for it. */
async function makeManualDenom(deliveryType: string = DeliveryType.MANUAL) {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Product ${Math.random()}`,
  });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: "SHARED",
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType });
  return denom;
}

/** Drive a fresh order to PENDING_VERIFICATION via createOrderDirect + attachPaymentProof
 * — the same path every real caller uses before calling settlePaidOrder. */
async function makePendingVerificationOrder(
  productId: number,
  quantity = 1,
  customerData?: string | null,
) {
  const order = await createOrderDirect(prisma, {
    user: sample.user,
    productId,
    quantity,
    customerData,
  });
  await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });
  return order!;
}

describe("settlePaidOrder", () => {
  it("auto SKU: behaves exactly like approveOrder — delivers, flips stock to SOLD", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 1);

    const result = await settlePaidOrder(prisma, order.id, { adminId });

    expect(result.kind).toBe("delivered");
    expect(result.credentials).toHaveLength(1);
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(freshOrder!.status).toBe(OrderStatus.DELIVERED);

    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, include: { stockItem: true } });
    expect(items).toHaveLength(1);
    expect(items[0]!.stockItem).not.toBeNull();
    expect(items[0]!.stockItem!.status).toBe(StockStatus.SOLD);
    expect(result.credentials[0]).toBe(items[0]!.stockItem!.credentials);
  });

  // M-5 (backend audit 2026-07-31): settlePaidOrder used to read the LIVE
  // denomination row to decide auto-vs-manual, so editing deliveryType while
  // an order was in flight could strand reserved stock (AUTO->manual edit) or
  // misroute a manual order into the auto-deliver branch (manual->AUTO edit).
  // deliveryTypeSnapshot freezes the decision at order-creation time instead.
  it("AUTO order reserves stock, denomination is edited to manual before payment: settlePaidOrder still delivers via the snapshot and sells the reserved stock (no stuck RESERVED rows)", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 1);

    // The reservation made at checkout time must still be RESERVED right now.
    const reservedBefore = await prisma.orderItem.findFirst({
      where: { orderId: order.id },
      include: { stockItem: true },
    });
    expect(reservedBefore!.stockItem).not.toBeNull();
    expect(reservedBefore!.stockItem!.status).toBe(StockStatus.RESERVED);
    expect(reservedBefore!.deliveryTypeSnapshot).toBe(DeliveryType.AUTO);

    // Admin flips the SKU to manual delivery while the order is still in flight.
    await updateDenomination(prisma, sample.product.id, { deliveryType: DeliveryType.MANUAL });

    const result = await settlePaidOrder(prisma, order.id, { adminId });

    // The snapshot (not the now-manual live row) decided the branch: still AUTO.
    expect(result.kind).toBe("delivered");
    expect(result.credentials).toHaveLength(1);

    const item = await prisma.orderItem.findFirst({
      where: { orderId: order.id },
      include: { stockItem: true },
    });
    // The reserved StockItem was sold, not abandoned — never left stuck RESERVED.
    expect(item!.stockItem).not.toBeNull();
    expect(item!.stockItem!.status).toBe(StockStatus.SOLD);
    expect(item!.stockItem!.status).not.toBe(StockStatus.RESERVED);
  });

  // Reverse edit: manual -> auto before payment must not strand a paid order.
  it("MANUAL order (no stock reserved), denomination is edited to auto before payment: settlePaidOrder still queues it for hand-fulfilment via the snapshot, instead of failing out-of-stock", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);

    const before = await prisma.orderItem.findFirst({ where: { orderId: order.id } });
    expect(before!.deliveryTypeSnapshot).toBe(DeliveryType.MANUAL);
    expect(before!.stockItemId).toBeNull();

    // Admin flips the SKU to auto delivery while the order is still in flight.
    // This denomination has zero stock rows, so taking the AUTO branch now
    // would fail with error.cannot_deliver_out_of_stock instead of queuing.
    await updateDenomination(prisma, manualDenom.id, { deliveryType: DeliveryType.AUTO });

    const result = await settlePaidOrder(prisma, order.id, { adminId });

    expect(result.kind).toBe("processing");
    expect(result.credentials).toEqual([]);
    const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(freshOrder!.status).toBe(OrderStatus.PROCESSING);
  });

  // Deploy-boundary safety net: this repo's real deploy convention is
  // `prisma db push` (docs/MIGRATIONS.md / CLAUDE.md), not `prisma migrate
  // deploy` — so a fresh deploy of the deliveryTypeSnapshot column never runs
  // the migration's backfill UPDATE and every pre-existing OrderItem row is
  // left with a null snapshot. settlePaidOrder must fall back to the live
  // denomination row for those rows (exactly the pre-Task-15 behavior),
  // rather than treating null as "auto" or throwing.
  it("null deliveryTypeSnapshot (simulating a pre-migration row): AUTO SKU still delivers and sells the reserved stock via the live denomination read", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 1);
    // Simulate a row that predates this column (db push leaves it null, no
    // backfill) — the live denomination (sample.product) is still AUTO.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { deliveryTypeSnapshot: null } });

    const result = await settlePaidOrder(prisma, order.id, { adminId });

    expect(result.kind).toBe("delivered");
    expect(result.credentials).toHaveLength(1);
    const item = await prisma.orderItem.findFirst({ where: { orderId: order.id }, include: { stockItem: true } });
    expect(item!.stockItem!.status).toBe(StockStatus.SOLD);
  });

  it("null deliveryTypeSnapshot (simulating a pre-migration row): MANUAL SKU still queues for hand-fulfilment via the live denomination read, instead of failing out-of-stock", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    // Simulate a row that predates this column — the live denomination is
    // still MANUAL. If this were misread as "auto" (e.g. a NOT NULL DEFAULT
    // 'auto' column), settlePaidOrder would try to pull stock for a SKU that
    // has none and throw error.cannot_deliver_out_of_stock instead.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { deliveryTypeSnapshot: null } });

    const result = await settlePaidOrder(prisma, order.id, { adminId });

    expect(result.kind).toBe("processing");
    expect(result.credentials).toEqual([]);
    const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(freshOrder!.status).toBe(OrderStatus.PROCESSING);
  });

  it("manual SKU: queues for hand-fulfilment instead of delivering, and touches no stock", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);

    const result = await settlePaidOrder(prisma, order.id, { adminId });

    expect(result.kind).toBe("processing");
    expect(result.credentials).toEqual([]);
    expect(result.order.status).toBe(OrderStatus.PROCESSING);

    const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
    expect(freshOrder!.status).toBe(OrderStatus.PROCESSING);
    expect(freshOrder!.paidAt).not.toBeNull();

    // No stock item exists at all for this denomination (manual never reserves any).
    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items.every((it) => it.stockItemId === null)).toBe(true);

    const outboxRow = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM },
    });
    expect(outboxRow).not.toBeNull();
  });
});

// Task 5: settlePaidOrder now enqueues the owner-email notifications added in
// Task 3 (packages/db/src/crud/notifications.ts) — OWNER_EMAIL_ORDER_PAID from
// the AUTO branch, OWNER_EMAIL_MANUAL_ORDER_QUEUED from the MANUAL branch,
// never both for the same order. resetDb (this file's beforeEach) wipes both
// Setting and NotificationOutbox before every test, so — unlike
// support.test.ts's owner-email suite — these tests assert absolute counts
// rather than before/after deltas.
describe("settlePaidOrder — owner-email triggers", () => {
  async function configureOwnerEmail(event: "paid_order" | "manual_queue") {
    await setSetting(prisma, "owner_email_enabled", "true");
    await setSetting(prisma, "owner_email", "owner@example.com");
    await setSetting(prisma, `owner_email_on_${event}`, "true");
  }

  it("AUTO settlement: enqueues exactly one OWNER_EMAIL_ORDER_PAID row with the full expanded payload (no voucher, transaction id from the attached payment proof), and no OWNER_EMAIL_MANUAL_ORDER_QUEUED row", async () => {
    await configureOwnerEmail("paid_order");
    const order = await makePendingVerificationOrder(sample.product.id, 1);

    await settlePaidOrder(prisma, order.id, { adminId });

    const paidRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.OWNER_EMAIL_ORDER_PAID },
    });
    expect(paidRows).toHaveLength(1);
    expect(paidRows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(paidRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "owner@example.com",
      order_code: order.orderCode,
      total: order.totalAmount.toString(),
      currency: order.currency,
      item_count: 1,
      customer_label: "Test User",
      items: [{ name: "Netflix Premium 1M", variant: "1 Month", quantity: 1, unitPrice: order.subtotalAmount.toString() }],
      subtotal: order.subtotalAmount.toString(),
      discount: "0", // no voucher applied
      payment_method: "BINANCE_PAY", // Order.paymentMethod's schema default — createOrderDirect never overrides it
      transaction_id: "TX-1", // makePendingVerificationOrder's attachPaymentProof call sets binanceTxid
      voucher_code: null,
      paid_at: expect.any(String),
      order_url: null, // config.ADMIN_PUBLIC_URL is unset in the test environment
    });
    // ISO-parseable, not a placeholder string.
    expect(new Date(payload.paid_at as string).toString()).not.toBe("Invalid Date");

    const manualQueueRows = await prisma.notificationOutbox.count({
      where: { orderId: order.id, event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED },
    });
    expect(manualQueueRows).toBe(0);
  });

  it("AUTO settlement with a voucher applied: the payload's voucher_code and discount reflect it", async () => {
    await configureOwnerEmail("paid_order");
    const order = await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
      voucherCode: sample.voucher.code, // "SAVE10", 10% PERCENT, seeded by buildSampleData
    });
    await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-VOUCHER" });

    await settlePaidOrder(prisma, order!.id, { adminId });

    const paidRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order!.id, event: NotificationEvent.OWNER_EMAIL_ORDER_PAID },
    });
    expect(paidRows).toHaveLength(1);
    const payload = JSON.parse(paidRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.voucher_code).toBe("SAVE10");
    // discountAmount is real and non-zero, and matches the order's own column
    // (not hand-recomputed here — applyVoucherToSubtotal's math is already
    // covered by the vouchers-domain tests).
    const freshOrder = await prisma.order.findUnique({ where: { id: order!.id } });
    expect(payload.discount).toBe(freshOrder!.discountAmount.toString());
    expect(freshOrder!.discountAmount.toString()).not.toBe("0");
  });

  it("AUTO settlement with no paymentRef/binanceTxid/bybitTxid set: the payload's transaction_id is null", async () => {
    await configureOwnerEmail("paid_order");
    const order = await makePendingVerificationOrder(sample.product.id, 1);
    // makePendingVerificationOrder's attachPaymentProof call always sets
    // binanceTxid — clear all three transaction-id columns to exercise the
    // "no gateway reference at all" case.
    await prisma.order.update({
      where: { id: order.id },
      data: { paymentRef: null, binanceTxid: null, bybitTxid: null },
    });

    await settlePaidOrder(prisma, order.id, { adminId });

    const paidRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.OWNER_EMAIL_ORDER_PAID },
    });
    expect(paidRows).toHaveLength(1);
    const payload = JSON.parse(paidRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.transaction_id).toBeNull();
    expect("transaction_id" in payload).toBe(true); // present as JSON null, not omitted
  });

  it("MANUAL settlement: enqueues exactly one OWNER_EMAIL_MANUAL_ORDER_QUEUED row with the correct payload, no OWNER_EMAIL_ORDER_PAID row, and still enqueues the existing ADMIN_MANUAL_ORDER_QUEUED Telegram alert", async () => {
    await configureOwnerEmail("manual_queue");
    await addAdminIdToDb(prisma, 5001);
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);

    await settlePaidOrder(prisma, order.id, { adminId });

    const queueRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED },
    });
    expect(queueRows).toHaveLength(1);
    expect(queueRows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(queueRows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload).toEqual({
      to: "owner@example.com",
      order_code: order.orderCode,
      items: [{ name: "Manual Denom", qty: 1 }],
      total: order.totalAmount.toString(),
      currency: order.currency,
    });

    // Mutual exclusivity: the AUTO branch's email must never fire alongside this one.
    const paidRows = await prisma.notificationOutbox.count({
      where: { orderId: order.id, event: NotificationEvent.OWNER_EMAIL_ORDER_PAID },
    });
    expect(paidRows).toBe(0);

    // This task must not disturb the pre-existing Telegram admin alert.
    const adminAlertRows = await prisma.notificationOutbox.count({
      where: { orderId: order.id, event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED },
    });
    expect(adminAlertRows).toBe(1);
  });

  it("owner-email not configured: neither OWNER_EMAIL_ORDER_PAID nor OWNER_EMAIL_MANUAL_ORDER_QUEUED is enqueued, in either branch", async () => {
    const autoOrder = await makePendingVerificationOrder(sample.product.id, 1);
    await settlePaidOrder(prisma, autoOrder.id, { adminId });

    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const manualOrder = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, manualOrder.id, { adminId });

    const ownerEmailCount = await prisma.notificationOutbox.count({
      where: {
        event: { in: [NotificationEvent.OWNER_EMAIL_ORDER_PAID, NotificationEvent.OWNER_EMAIL_MANUAL_ORDER_QUEUED] },
      },
    });
    expect(ownerEmailCount).toBe(0);
  });
});

describe("fulfillManualOrder", () => {
  it("delivers a PROCESSING order with the admin-typed content and enqueues the buyer DM", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });

    const { order: delivered } = await fulfillManualOrder(prisma, order.id, {
      adminId,
      content: "  user:x pass:y  ",
    });

    expect(delivered.status).toBe(OrderStatus.DELIVERED);
    expect(delivered.deliveredContent).toBe("user:x pass:y");
    expect(delivered.deliveredAt).not.toBeNull();

    const history = await prisma.orderStatusHistory.findFirst({
      where: { orderId: order.id, status: OrderStatus.DELIVERED },
    });
    expect(history).not.toBeNull();

    const outboxRow = await prisma.notificationOutbox.findFirst({
      where: { orderId: order.id, event: NotificationEvent.ORDER_MANUAL_DELIVERED_DM },
    });
    expect(outboxRow).not.toBeNull();
  });

  it("double-fulfil guard: a second call on an already-DELIVERED order throws error.order_not_processing", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });
    await fulfillManualOrder(prisma, order.id, { adminId, content: "first delivery" });

    let caught: unknown;
    try {
      await fulfillManualOrder(prisma, order.id, { adminId, content: "second delivery" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).key).toBe("error.order_not_processing");

    // The first delivery's content must survive untouched.
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.deliveredContent).toBe("first delivery");
  });

  it("empty/whitespace-only content throws error.manual_content_required and leaves the order PROCESSING", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });

    let caught: unknown;
    try {
      await fulfillManualOrder(prisma, order.id, { adminId, content: "   " });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).key).toBe("error.manual_content_required");

    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.status).toBe(OrderStatus.PROCESSING);
    expect(fresh!.deliveredContent).toBeNull();
  });
});

describe("createOrderDirect — manual denomination", () => {
  it("skips stock entirely (no rows created, stockItemId null) and persists customerData that matches the field spec, unchanged", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO);
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
    ];
    await updateDenomination(prisma, manualDenom.id, { additionalFields: JSON.stringify(fields) });
    const customerData = JSON.stringify([{ game_id: "12345" }]);

    const order = await createOrderDirect(prisma, {
      user: sample.user,
      productId: manualDenom.id,
      quantity: 1,
      customerData,
    });

    expect(order!.customerData).toBe(customerData);

    const items = await prisma.orderItem.findMany({ where: { orderId: order!.id } });
    expect(items).toHaveLength(1);
    expect(items[0]!.stockItemId).toBeNull();

    const stockCount = await prisma.stockItem.count({ where: { productId: manualDenom.id } });
    expect(stockCount).toBe(0);
  });

  // Finding #4 (audit-per-sku-delivery-flows-2026-07-13.md): the bot's
  // info-collection gate only checked scratch.customerData was PRESENT, not
  // that it still matched the CURRENT product/quantity — a buyer who backs
  // out and bumps quantity after finishing the wizard could reach checkout
  // with stale answers. createOrderDirect (shared by all 7 bot buyNow*
  // handlers + completeOrderWithWallet + wallet_checkout's
  // completeOrderWithWalletCredit) now re-validates via validateCustomerData
  // right before persisting, so a mismatched answer count throws instead of
  // silently persisting.
  it("throws error.customer_data_incomplete when customerData doesn't match the CURRENT quantity (Finding #4 regression)", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO);
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
    ];
    await updateDenomination(prisma, manualDenom.id, { additionalFields: JSON.stringify(fields) });
    // Answers collected for quantity=1 (one unit's worth), but the order is
    // now being placed for quantity=2 — exactly the "quantity changed after
    // the wizard completed" scenario Finding #4 describes.
    const staleCustomerData = JSON.stringify([{ game_id: "12345" }]);

    let caught: unknown;
    try {
      await createOrderDirect(prisma, {
        user: sample.user,
        productId: manualDenom.id,
        quantity: 2,
        customerData: staleCustomerData,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).key).toBe("error.customer_data_incomplete");

    // No stray order/order-item rows were left behind by the failed create.
    const orders = await prisma.order.findMany({ where: { userId: sample.user.id } });
    expect(orders).toHaveLength(0);
  });
});

describe("updateOrderCustomerData", () => {
  it("re-validates and persists new answers while the order is PROCESSING", async () => {
    const fields: AdditionalField[] = [
      { key: "game_id", label: { id: "ID Game", en: "Game ID" }, type: AdditionalFieldType.TEXT, required: true, options: [], placeholder: "" },
    ];
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO);
    await updateDenomination(prisma, manualDenom.id, { additionalFields: JSON.stringify(fields) });

    const order = await makePendingVerificationOrder(manualDenom.id, 1, JSON.stringify([{ game_id: "initial" }]));
    await settlePaidOrder(prisma, order.id, { adminId });

    const updated = await updateOrderCustomerData(prisma, order.id, [{ game_id: "999" }]);
    expect(JSON.parse(updated.customerData!)).toEqual([{ game_id: "999" }]);
  });

  it("throws error.order_not_processing once the order has left PROCESSING", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });
    await fulfillManualOrder(prisma, order.id, { adminId, content: "delivered" });

    let caught: unknown;
    try {
      await updateOrderCustomerData(prisma, order.id, []);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).key).toBe("error.order_not_processing");
  });
});

describe("LEGAL_TRANSITIONS (PROCESSING state)", () => {
  it("PENDING_VERIFICATION -> PROCESSING is a legal shape, per the map and via transitionOrderStatus", async () => {
    expect(LEGAL_TRANSITIONS[OrderStatus.PENDING_VERIFICATION]).toContain(OrderStatus.PROCESSING);

    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "1",
        totalAmount: "1",
        status: OrderStatus.PENDING_VERIFICATION,
      },
    });
    await transitionOrderStatus(prisma, {
      orderId: order.id,
      from: OrderStatus.PENDING_VERIFICATION,
      to: OrderStatus.PROCESSING,
    });
    const fresh = await prisma.order.findUnique({ where: { id: order.id } });
    expect(fresh!.status).toBe(OrderStatus.PROCESSING);
  });

  it("PROCESSING -> PENDING_PAYMENT is illegal, per the map and via transitionOrderStatus", async () => {
    expect(LEGAL_TRANSITIONS[OrderStatus.PROCESSING]).not.toContain(OrderStatus.PENDING_PAYMENT);

    const order = await prisma.order.create({
      data: {
        orderCode: `ORD-${Math.random()}`,
        userId: sample.user.id,
        subtotalAmount: "1",
        totalAmount: "1",
        status: OrderStatus.PROCESSING,
      },
    });
    await expect(
      transitionOrderStatus(prisma, {
        orderId: order.id,
        from: OrderStatus.PROCESSING,
        to: OrderStatus.PENDING_PAYMENT,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("validateFieldAnswer (pure, @app/core/deliveryFields)", () => {
  const baseField = (overrides: Partial<AdditionalField>): AdditionalField => ({
    key: "f",
    label: { id: "F", en: "F" },
    type: AdditionalFieldType.TEXT,
    required: true,
    options: [],
    placeholder: "",
    ...overrides,
  });

  it("email: accepts a valid address", () => {
    const field = baseField({ type: AdditionalFieldType.EMAIL });
    expect(validateFieldAnswer(field, "user@example.com")).toBe("user@example.com");
  });

  it("email: rejects an invalid address", () => {
    const field = baseField({ type: AdditionalFieldType.EMAIL });
    expect(() => validateFieldAnswer(field, "not-an-email")).toThrow(ValidationError);
  });

  it("number: accepts an all-digits value", () => {
    const field = baseField({ type: AdditionalFieldType.NUMBER });
    expect(validateFieldAnswer(field, "12345")).toBe("12345");
  });

  it("number: rejects a non-digit value", () => {
    const field = baseField({ type: AdditionalFieldType.NUMBER });
    expect(() => validateFieldAnswer(field, "12a45")).toThrow(ValidationError);
  });

  it("url: accepts a valid http(s) URL", () => {
    const field = baseField({ type: AdditionalFieldType.URL });
    expect(validateFieldAnswer(field, "https://example.com/x")).toBe("https://example.com/x");
  });

  it("url: rejects a malformed URL", () => {
    const field = baseField({ type: AdditionalFieldType.URL });
    expect(() => validateFieldAnswer(field, "not a url")).toThrow(ValidationError);
  });

  it("select: accepts a value present in options", () => {
    const field = baseField({ type: AdditionalFieldType.SELECT, options: ["a", "b"] });
    expect(validateFieldAnswer(field, "b")).toBe("b");
  });

  it("select: rejects a value not present in options", () => {
    const field = baseField({ type: AdditionalFieldType.SELECT, options: ["a", "b"] });
    expect(() => validateFieldAnswer(field, "c")).toThrow(ValidationError);
  });

  it("required text: throws error.field_required when empty", () => {
    const field = baseField({ type: AdditionalFieldType.TEXT, required: true });
    expect(() => validateFieldAnswer(field, "")).toThrow(ValidationError);
    try {
      validateFieldAnswer(field, "   ");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).key).toBe("error.field_required");
    }
  });

  it("optional text: returns '' when empty, without throwing", () => {
    const field = baseField({ type: AdditionalFieldType.TEXT, required: false });
    expect(validateFieldAnswer(field, "")).toBe("");
    expect(validateFieldAnswer(field, undefined)).toBe("");
  });
});
