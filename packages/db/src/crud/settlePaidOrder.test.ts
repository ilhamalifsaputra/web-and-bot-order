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
  approveOrder,
  fulfillManualOrder,
  createOrderDirect,
  attachPaymentProof,
  updateOrderCustomerData,
} from "./orders";
import { createWalletTopupOrder } from "./wallet_topup";
import { markStockDead } from "./stock";
import { decryptCredentials } from "@app/core/credentialCrypto";
import { createCategory, createCatalogProduct, createDenomination, updateDenomination } from "./catalog";
import { LEGAL_TRANSITIONS, transitionOrderStatus } from "./orderStatus";
import {
  DeliveryType,
  OrderStatus,
  NotificationEvent,
  StockStatus,
  StockActorType,
  StockEventType,
} from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import {
  validateFieldAnswer,
  AdditionalFieldType,
  type AdditionalField,
} from "@app/core/deliveryFields";
import { setSetting } from "./settings";
import { addAdminIdToDb } from "./admins";
import { finalizeOrderPayment } from "./pricing";
import { usdtFromIdr } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { OrderCurrency, PaymentMethod } from "@app/core/enums";
import { config } from "@app/core/config";

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
async function makeManualDenom(deliveryType: string = DeliveryType.MANUAL, price: string = "10.00") {
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
    price,
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
    // `items` is fetched directly (not via getOrder, which decrypts) — the
    // raw column value is the encrypted envelope, so decrypt before comparing.
    expect(result.credentials[0]).toBe(decryptCredentials(items[0]!.stockItem!.credentials));
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

  it("AUTO settlement for a USDT-settled order: the payload's subtotal, discount, and item unitPrice are converted via the order's fxRate — not left as raw IDR", async () => {
    await configureOwnerEmail("paid_order");
    const order = await makePendingVerificationOrder(sample.product.id, 1);

    // Simulate a USDT-settled order the way finalizeOrderPayment would have
    // left it (this test only needs the DB row shape settlePaidOrder reads
    // — it doesn't need to drive the full payment-finalization flow).
    const rate = "16000"; // 16,000 IDR per USDT, a plausible rate
    await prisma.order.update({
      where: { id: order.id },
      data: { currency: "USDT", fxRate: rate },
    });

    await settlePaidOrder(prisma, order.id, { adminId });

    const paidRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: NotificationEvent.OWNER_EMAIL_ORDER_PAID },
    });
    expect(paidRows).toHaveLength(1);
    const payload = JSON.parse(paidRows[0]!.payloadJson) as Record<string, unknown>;

    // usdtFromIdr rounds to the nearest 0.1 — compute the expected value the
    // same way the fix does, then assert against it (don't hardcode a magic
    // number that could silently drift from sample.product's actual price).
    const freshOrder = await prisma.order.findUnique({ where: { id: order.id } });
    const expectedSubtotal = usdtFromIdr(freshOrder!.subtotalAmount, rate).toString();
    expect(payload.subtotal).toBe(expectedSubtotal);
    expect((payload.items as Array<{ unitPrice: unknown }>)[0]!.unitPrice).toBe(expectedSubtotal);
    // No voucher applied — discountAmount is 0, and usdtFromIdr(0, rate) is
    // still 0, so this must stay "0" (not some non-zero rounding artifact).
    expect(payload.discount).toBe("0");
    // Total is untouched by this fix — still the pre-existing correctly
    // -converted value, unrelated to subtotal/discount.
    expect(payload.total).toBe(freshOrder!.totalAmount.toString());
    expect(payload.currency).toBe("USDT");
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

/**
 * BUYER_EMAIL_ORDER_READY — the guest shopper's own "your order is ready"
 * email. Structurally unlike the owner-email suite above: no Settings are
 * configured anywhere in this block, because this event has no owner toggle.
 * The only gate is `order.user.isGuest && order.user.guestEmail`.
 *
 * Two call sites are covered deliberately. A guest who buys a MANUAL SKU
 * never passes through settlePaidOrder's AUTO branch — their order goes to
 * PROCESSING and only finishes later in fulfillManualOrder — so a single
 * AUTO-branch call site would silently give that buyer nothing at all.
 */
describe("BUYER_EMAIL_ORDER_READY (guest buyer's order-ready email)", () => {
  const GUEST_EMAIL = "guest-buyer@example.com";

  /** Turn the shared sample user into a guest shopper with a contact
   * address — the shape `establishGuestCustomer` produces at storefront
   * checkout. */
  async function makeSampleUserAGuest(guestEmail: string | null = GUEST_EMAIL) {
    await prisma.user.update({
      where: { id: sample.user.id },
      data: { isGuest: true, guestEmail },
    });
  }

  async function readyRows(orderId: number) {
    return prisma.notificationOutbox.findMany({
      where: { orderId, event: NotificationEvent.BUYER_EMAIL_ORDER_READY },
    });
  }

  it("AUTO settlement for a guest: enqueues exactly one EMAIL row addressed to the guest's own email", async () => {
    await makeSampleUserAGuest();
    const order = await makePendingVerificationOrder(sample.product.id, 1);

    await settlePaidOrder(prisma, order.id, { adminId });

    const rows = await readyRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.to).toBe(GUEST_EMAIL);
    expect(payload.order_code).toBe(order.orderCode);
    expect(payload.currency).toBe(order.currency);
    expect(payload.total).toBe(order.totalAmount.toString());
    expect(payload.subtotal).toBe(order.subtotalAmount.toString());
    expect(payload.discount).toBe("0");
    expect(payload.items).toEqual([
      {
        name: "Netflix Premium 1M",
        variant: "1 Month",
        quantity: 1,
        unitPrice: order.subtotalAmount.toString(),
        lineTotal: order.subtotalAmount.toString(),
      },
    ]);
    // buildSampleData's denomination is created with warrantyDays: 30, frozen
    // onto the OrderItem as warrantyDaysSnapshot at order-creation time.
    expect(payload.warranty_days).toBe(30);
    // Neither SHOP_PUBLIC_URL nor PUBLIC_URL is set in the test environment,
    // so both links come through as explicit nulls — the renderer, not this
    // layer, decides to hide the button. Same treatment ADMIN_PUBLIC_URL gets
    // in the owner-email suite above.
    expect(payload.order_url).toBeNull();
    expect(payload.track_url).toBeNull();
  });

  it("MANUAL SKU for a guest: nothing at settle time, exactly one row when fulfillManualOrder actually finishes it", async () => {
    await makeSampleUserAGuest();
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);

    // Settling a MANUAL order only queues it for hand-fulfilment — it is not
    // ready yet, so no "your order is ready" email may go out here.
    await settlePaidOrder(prisma, order.id, { adminId });
    expect(await readyRows(order.id)).toHaveLength(0);

    await fulfillManualOrder(prisma, order.id, { adminId, content: "user:pass" });

    const rows = await readyRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("EMAIL");
    const payload = JSON.parse(rows[0]!.payloadJson) as Record<string, unknown>;
    expect(payload.to).toBe(GUEST_EMAIL);
    expect(payload.order_code).toBe(order.orderCode);
  });

  /**
   * Collapse an order's per-unit OrderItem rows into ONE row of
   * `quantity: n`, leaving `Order.subtotalAmount` untouched.
   *
   * Both order-creation paths persist one `quantity: 1` row per unit today
   * (createOrderDirect's reservation loop, createOrderFromCart's createMany),
   * so a real order never arrives here with a multi-unit line. The column,
   * the payload, and the receipt's "n x unit = lineTotal" rendering all
   * support one anyway, and the arithmetic on that line has to be right the
   * day anything starts grouping — which is exactly what these two tests pin.
   */
  async function collapseItemsIntoOneLine(orderId: number, quantity: number) {
    const items = await prisma.orderItem.findMany({ where: { orderId }, orderBy: { id: "asc" } });
    await prisma.orderItem.deleteMany({ where: { id: { in: items.slice(1).map((it) => it.id) } } });
    await prisma.orderItem.update({ where: { id: items[0]!.id }, data: { quantity } });
  }

  // Line-total rounding regression. `usdtFromIdr`'s own doc states the rule:
  // convert once per displayed figure, NEVER per component. An item's line
  // total used to be derived downstream as `unitPrice * quantity` from a unit
  // price that had already been rounded to the nearest 0.1 USDT, which
  // multiplies that rounding error by the quantity.
  //
  // 5 x Rp8.900 at an fxRate of 16.000 is the sharpest small case (M13 / P2-1
  // shrank the gap from 0.2 to 0.01 by moving the step from 0.1 to 0.01, but
  // did not close it — a smaller contradiction is still a contradiction):
  //   unit    8.900 / 16.000 = 0.55625  -> rounds UP to 0.56 USDT
  //   naive   0.56 x 5                  =  2.80 USDT   (wrong)
  //   correct 44.500 / 16.000 = 2.78125 -> 2.79 USDT   (== the subtotal)
  // The receipt would otherwise print "5 x 0.56 = 2.80" directly above
  // "Subtotal 2.79" — a 0.01 USDT self-contradiction in front of the buyer.
  it("USDT multi-quantity line: lineTotal is converted once from the central-IDR line, so it agrees with the subtotal instead of scaling a rounded unit price", async () => {
    await makeSampleUserAGuest();
    const denom = await makeManualDenom(DeliveryType.MANUAL, "8900");
    const order = await makePendingVerificationOrder(denom.id, 5);
    await collapseItemsIntoOneLine(order.id, 5);
    // Simulate a USDT-settled order the way finalizeOrderPayment would have
    // left it: subtotal/unitPrice stay central-IDR, but `totalAmount` is
    // converted — ceil(baseIdr / rate, 0.01) plus the unique cents. Patching
    // only currency+fxRate and leaving a central-IDR total behind would be a
    // state no real order is ever in, and the receipt's figures are now
    // derived from that total.
    const preFinalize = (await prisma.order.findUnique({ where: { id: order.id } }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        currency: "USDT",
        fxRate: "16000",
        totalAmount: usdtFromIdr(new Decimal(preFinalize.totalAmount).minus(preFinalize.uniqueCents), "16000")
          .plus(preFinalize.uniqueCents)
          .toString(),
      },
    });

    await settlePaidOrder(prisma, order.id, { adminId });
    await fulfillManualOrder(prisma, order.id, { adminId, content: "user:pass" });

    const payload = JSON.parse((await readyRows(order.id))[0]!.payloadJson) as Record<string, unknown>;
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]!.quantity).toBe(5);
    expect(items[0]!.unitPrice).toBe(usdtFromIdr("8900", "16000").toString()); // "0.56"
    expect(items[0]!.lineTotal).toBe(usdtFromIdr("44500", "16000").toString()); // "2.79"
    // The naive product of the rounded unit price (0.56 x 5) — the bug being pinned.
    expect(items[0]!.lineTotal).not.toBe("2.8");
    // This order has exactly one item line, so its line total IS the subtotal.
    // Anything else is a receipt that contradicts itself.
    expect(items[0]!.lineTotal).toBe(payload.subtotal);
    expect(payload.subtotal).toBe("2.79");
  });

  it("IDR multi-quantity line (no conversion happens): lineTotal is the plain quantity x unitPrice product", async () => {
    await makeSampleUserAGuest();
    const denom = await makeManualDenom(DeliveryType.MANUAL, "8900");
    const order = await makePendingVerificationOrder(denom.id, 5);
    await collapseItemsIntoOneLine(order.id, 5);

    await settlePaidOrder(prisma, order.id, { adminId });
    await fulfillManualOrder(prisma, order.id, { adminId, content: "user:pass" });

    const payload = JSON.parse((await readyRows(order.id))[0]!.payloadJson) as Record<string, unknown>;
    const items = payload.items as Array<Record<string, unknown>>;
    expect(items[0]!.unitPrice).toBe("8900");
    expect(items[0]!.lineTotal).toBe("44500");
    expect(items[0]!.lineTotal).toBe(payload.subtotal);
  });

  /**
   * The receipt must RECONCILE, not merely be roughly right — the reader is
   * the customer who just paid, and a summary that does not add up reads as
   * an overcharge.
   *
   * Three separate roundings used to guarantee it never would. `subtotal` and
   * `discount` were each converted independently on their own while `total`
   * had already been converted, once, by finalizeOrderPayment — and on top of
   * that, finalizeOrderPayment folds 0.002-0.098 USDT of deterministic
   * "unique cents" into `totalAmount` (so the payment poller can match the
   * transfer by amount) that no line of the receipt printed at all.
   *
   * Rp32.080 with a Rp16.016 voucher at an fxRate of 16.000 is the clean
   * worked example of the rounding half (M13 / P2-1's 0.01-ceil step shrank
   * the gap this used to demonstrate — Rp45.000/Rp9.000 no longer
   * discriminates, because subtotal(2.82) - net(2.25) happens to equal the
   * independently-converted discount(0.57) exactly at that pair; this one
   * still does not):
   *   subtotal 32.080 / 16.000 = 2.005   -> 2.01 USDT
   *   discount 16.016 / 16.000 = 1.001   -> 1.01 USDT   (converted alone)
   *   net      16.064 / 16.000 = 1.004   -> 1.01 USDT   (what total is built on)
   * An independently-converted discount would print "2.01 - 1.01 = 1.00"
   * beside a total built on 1.01 + cents — a contradiction. The DERIVED
   * discount (subtotal minus net, both already converted) is "1", which
   * agrees with the total by construction.
   */
  const USDT_RATE = "16000";
  const PRICE_IDR = "32080";
  const DISCOUNT_IDR = "16016";

  /**
   * A guest order settled in USDT on a given rail, driven through the real
   * `finalizeOrderPayment` rather than a hand-written DB row — the unique
   * cents, the fxRate snapshot and the converted total all have to be the
   * ones production actually produces for this test to mean anything.
   *
   * The voucher discount is applied by rewriting the central-IDR shell the
   * way order creation would have (subtotal - discount, with the unique cents
   * order creation already stamped still riding on top), because
   * createOrderDirect has no voucher argument.
   */
  async function makeUsdtGuestOrder(
    method: string,
    opts: { priceIdr?: string; discountIdr?: string } = {},
  ): Promise<number> {
    const priceIdr = opts.priceIdr ?? PRICE_IDR;
    const discountIdr = opts.discountIdr ?? "0";
    const denom = await makeManualDenom(DeliveryType.MANUAL, priceIdr);
    const created = await createOrderDirect(prisma, {
      user: sample.user,
      productId: denom.id,
      quantity: 1,
    });
    const shell = (await prisma.order.findUnique({ where: { id: created!.id } }))!;
    await prisma.order.update({
      where: { id: shell.id },
      data: {
        discountAmount: discountIdr,
        totalAmount: new Decimal(priceIdr).minus(discountIdr).plus(shell.uniqueCents).toString(),
      },
    });
    await finalizeOrderPayment(prisma, shell.id, {
      currency: OrderCurrency.USDT,
      rate: USDT_RATE,
      method: method as never,
    });
    await attachPaymentProof(prisma, shell.id, { fileId: "file123", txid: "TX-1" });
    return shell.id;
  }

  /** Settle + hand-fulfil a MANUAL order and return its receipt payload. */
  async function deliverAndReadReceipt(orderId: number) {
    await settlePaidOrder(prisma, orderId, { adminId });
    await fulfillManualOrder(prisma, orderId, { adminId, content: "user:pass" });
    return JSON.parse((await readyRows(orderId))[0]!.payloadJson) as Record<string, unknown>;
  }

  // Every USDT rail the storefront offers reaches this receipt
  // (apps/storefront/src/routes/checkout.ts maps the buyer's choice onto all
  // four), and finalizeOrderPayment gives every one of them unique cents —
  // only WALLET is excluded. Testing one rail would leave three shipping the
  // broken receipt.
  const USDT_RAILS = [
    PaymentMethod.BINANCE_INTERNAL,
    PaymentMethod.BYBIT,
    PaymentMethod.BYBIT_BSC,
    PaymentMethod.NOWPAYMENTS,
  ];

  it.each(USDT_RAILS)(
    "USDT receipt on the %s rail: subtotal - discount + unique cents equals the total, exactly",
    async (method) => {
      await makeSampleUserAGuest();
      const orderId = await makeUsdtGuestOrder(method, { discountIdr: DISCOUNT_IDR });
      const order = (await prisma.order.findUnique({ where: { id: orderId } }))!;

      const payload = await deliverAndReadReceipt(orderId);

      expect(payload.currency).toBe("USDT");
      // The unique cents are real money the buyer transferred — the receipt
      // has to carry them, or it can never balance.
      expect(payload.unique_cents).toBe(order.uniqueCents.toString());
      expect(new Decimal(String(payload.unique_cents)).isZero()).toBe(false);
      expect(payload.total).toBe(order.totalAmount.toString());

      const subtotal = new Decimal(String(payload.subtotal));
      const discount = new Decimal(String(payload.discount));
      const unique = new Decimal(String(payload.unique_cents));
      expect(subtotal.minus(discount).plus(unique).toString()).toBe(String(payload.total));
    },
  );

  it("USDT receipt: the subtotal stays the converted subtotal and the discount absorbs the rounding, so the figures above the total keep their meaning", async () => {
    await makeSampleUserAGuest();
    const orderId = await makeUsdtGuestOrder(PaymentMethod.BINANCE_INTERNAL, { discountIdr: DISCOUNT_IDR });

    const payload = await deliverAndReadReceipt(orderId);

    // Anchored: converted once from central IDR, exactly as before.
    expect(payload.subtotal).toBe(usdtFromIdr(PRICE_IDR, USDT_RATE).toString()); // "2.01"
    // Derived: subtotal minus the net the total is actually built on (1.01),
    // NOT the independently-rounded 16.016/16.000 = 1.001 -> "1.01" that would
    // otherwise leave the receipt contradicting its own total.
    expect(payload.discount).toBe("1");
    expect(payload.discount).not.toBe(usdtFromIdr(DISCOUNT_IDR, USDT_RATE).toString());
  });

  it("USDT receipt with no discount at all: still balances, and prints no discount", async () => {
    await makeSampleUserAGuest();
    const orderId = await makeUsdtGuestOrder(PaymentMethod.NOWPAYMENTS);
    const order = (await prisma.order.findUnique({ where: { id: orderId } }))!;

    const payload = await deliverAndReadReceipt(orderId);

    expect(payload.discount).toBe("0");
    expect(payload.subtotal).toBe(usdtFromIdr(PRICE_IDR, USDT_RATE).toString());
    const subtotal = new Decimal(String(payload.subtotal));
    const unique = new Decimal(String(payload.unique_cents));
    expect(subtotal.plus(unique).toString()).toBe(order.totalAmount.toString());
  });

  it("IDR receipt (TOKOPAY): unchanged central-IDR figures, and no unique cents to print", async () => {
    await makeSampleUserAGuest();
    const denom = await makeManualDenom(DeliveryType.MANUAL, PRICE_IDR);
    const created = await createOrderDirect(prisma, {
      user: sample.user,
      productId: denom.id,
      quantity: 1,
    });
    // finalizeOrderPayment's IDR branch strips the unique cents (QRIS
    // confirms by callback, not by amount matching) and converts nothing.
    await finalizeOrderPayment(prisma, created!.id, {
      currency: OrderCurrency.IDR,
      method: PaymentMethod.TOKOPAY,
    });
    await attachPaymentProof(prisma, created!.id, { fileId: "file123", txid: "TX-1" });
    const order = (await prisma.order.findUnique({ where: { id: created!.id } }))!;

    const payload = await deliverAndReadReceipt(created!.id);

    expect(payload.currency).toBe("IDR");
    expect(payload.subtotal).toBe(order.subtotalAmount.toString());
    expect(payload.discount).toBe(order.discountAmount.toString());
    expect(payload.total).toBe(order.totalAmount.toString());
    expect(payload.unique_cents).toBe("0");
    // And it balances on its own terms: Rp45.000 - Rp0 + Rp0 = Rp45.000.
    const subtotal = new Decimal(String(payload.subtotal));
    const discount = new Decimal(String(payload.discount));
    const unique = new Decimal(String(payload.unique_cents));
    expect(subtotal.minus(discount).plus(unique).toString()).toBe(String(payload.total));
  });

  /**
   * An IDR guest order carrying a bulk discount, and optionally a voucher on
   * top. `createOrderDirect` takes neither, so the central-IDR shell is
   * rewritten the way cart creation would have left it —
   * `total = subtotal - bulk - voucher` (see `afterDiscount` in
   * createOrderFromCart) — before the IDR branch of `finalizeOrderPayment`
   * runs and zeroes the unique cents.
   */
  async function makeIdrGuestOrder(
    opts: { priceIdr?: string; bulkIdr?: string; voucherIdr?: string } = {},
  ): Promise<number> {
    const priceIdr = opts.priceIdr ?? PRICE_IDR;
    const bulkIdr = opts.bulkIdr ?? "0";
    const voucherIdr = opts.voucherIdr ?? "0";
    const denom = await makeManualDenom(DeliveryType.MANUAL, priceIdr);
    const created = await createOrderDirect(prisma, { user: sample.user, productId: denom.id, quantity: 1 });
    await prisma.order.update({
      where: { id: created!.id },
      data: {
        bulkDiscountAmount: bulkIdr,
        discountAmount: voucherIdr,
        totalAmount: new Decimal(priceIdr).minus(bulkIdr).minus(voucherIdr).toString(),
      },
    });
    await finalizeOrderPayment(prisma, created!.id, {
      currency: OrderCurrency.IDR,
      method: PaymentMethod.TOKOPAY,
    });
    await attachPaymentProof(prisma, created!.id, { fileId: "file123", txid: "TX-1" });
    return created!.id;
  }

  // A bulk discount reduces the total exactly as a voucher does, but it is
  // stored in its OWN column. Printing `discountAmount` verbatim therefore
  // dropped it off the page entirely: subtotal and total disagreed by the bulk
  // amount with no row explaining the gap — on the IDR rails, which carry most
  // of this shop's traffic.
  it("IDR receipt with a bulk discount: the bulk reduction is shown, and the figures reconcile", async () => {
    await makeSampleUserAGuest();
    const orderId = await makeIdrGuestOrder({ priceIdr: "100000", bulkIdr: "10000" });

    const payload = await deliverAndReadReceipt(orderId);

    expect(payload.subtotal).toBe("100000");
    expect(payload.discount).toBe("10000"); // was "0" — the bulk reduction vanished
    expect(payload.total).toBe("90000");
    const subtotal = new Decimal(String(payload.subtotal));
    const discount = new Decimal(String(payload.discount));
    const unique = new Decimal(String(payload.unique_cents));
    expect(subtotal.minus(discount).plus(unique).toString()).toBe(String(payload.total));
  });

  it("IDR receipt with a bulk discount AND a voucher: one row covering both, still reconciling", async () => {
    await makeSampleUserAGuest();
    const orderId = await makeIdrGuestOrder({ priceIdr: "100000", bulkIdr: "10000", voucherIdr: "5000" });

    const payload = await deliverAndReadReceipt(orderId);

    expect(payload.subtotal).toBe("100000");
    expect(payload.discount).toBe("15000"); // bulk + voucher, not the voucher alone
    expect(payload.total).toBe("85000");
    const subtotal = new Decimal(String(payload.subtotal));
    const discount = new Decimal(String(payload.discount));
    expect(subtotal.minus(discount).toString()).toBe(String(payload.total));
  });

  // Wallet credit is the one thing that could silently poison the derived
  // discount: `walletUsed` is subtracted from the total but never shown, so
  // a wallet-paying buyer would see it folded into "Discount". Guests have no
  // wallet — the storefront never offers one and a guest User row is created
  // with a zero balance — so the receipt can rely on that. Pinned rather than
  // assumed, because the derivation depends on it.
  it("a guest order never carries wallet credit, so nothing invisible can leak into the derived discount", async () => {
    await makeSampleUserAGuest();
    const orderId = await makeUsdtGuestOrder(PaymentMethod.BYBIT, { discountIdr: DISCOUNT_IDR });
    const order = (await prisma.order.findUnique({ where: { id: orderId } }))!;
    const guest = (await prisma.user.findUnique({ where: { id: sample.user.id } }))!;

    expect(new Decimal(order.walletUsed).isZero()).toBe(true);
    expect(new Decimal(guest.walletBalance).isZero()).toBe(true);

    const payload = await deliverAndReadReceipt(orderId);
    // With no wallet credit, the net the total is built on is exactly
    // subtotal - discount, so the derived discount is a discount and nothing
    // else.
    expect(new Decimal(String(payload.subtotal)).minus(String(payload.discount)).toString()).toBe(
      new Decimal(order.totalAmount).minus(order.uniqueCents).toString(),
    );
  });

  it("registered (non-guest) buyer: no row, in either branch", async () => {
    // sample.user is a normal Telegram-account user — isGuest defaults false.
    const autoOrder = await makePendingVerificationOrder(sample.product.id, 1);
    await settlePaidOrder(prisma, autoOrder.id, { adminId });

    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const manualOrder = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, manualOrder.id, { adminId });
    await fulfillManualOrder(prisma, manualOrder.id, { adminId, content: "user:pass" });

    expect(
      await prisma.notificationOutbox.count({
        where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY },
      }),
    ).toBe(0);
  });

  it("guest with no guestEmail: no row, in either branch — there is nowhere to send it", async () => {
    await makeSampleUserAGuest(null);

    const autoOrder = await makePendingVerificationOrder(sample.product.id, 1);
    await settlePaidOrder(prisma, autoOrder.id, { adminId });

    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const manualOrder = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, manualOrder.id, { adminId });
    await fulfillManualOrder(prisma, manualOrder.id, { adminId, content: "user:pass" });

    expect(
      await prisma.notificationOutbox.count({
        where: { event: NotificationEvent.BUYER_EMAIL_ORDER_READY },
      }),
    ).toBe(0);
  });

  // The guard that matters most. This email exists BECAUSE credentials are
  // never mailed — and the outbox payload is additionally visible in the
  // admin /outbox panel. fulfillManualOrder is the sharpest test of it: the
  // admin literally types the credential in as `content` on the same call
  // that enqueues this row, so a careless payload would carry it straight
  // through.
  it("payload carries no credentials — not the admin-typed manual content, not the auto-delivered stock credentials", async () => {
    const SECRET = "supersecret-credential-value";

    await makeSampleUserAGuest();
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const manualOrder = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, manualOrder.id, { adminId });
    await fulfillManualOrder(prisma, manualOrder.id, { adminId, content: SECRET });

    const manualRow = (await readyRows(manualOrder.id))[0]!;
    expect(manualRow.payloadJson).not.toContain(SECRET);
    expect(manualRow.payloadJson).not.toContain("deliveredContent");
    expect(manualRow.payloadJson).not.toContain("delivered_content");
    expect(manualRow.payloadJson).not.toContain("credentials");

    // And the AUTO branch, whose credentials come from the stock pool
    // (bulkAddStock seeds "userN@example.com:pwdN" rows).
    const autoOrder = await makePendingVerificationOrder(sample.product.id, 1);
    const settled = await settlePaidOrder(prisma, autoOrder.id, { adminId });
    expect(settled.kind).toBe("delivered");
    expect(settled.credentials).toHaveLength(1);

    const autoRow = (await readyRows(autoOrder.id))[0]!;
    expect(autoRow.payloadJson).not.toContain(settled.credentials[0]!);
    expect(autoRow.payloadJson).not.toContain("credentials");
  });

  it("builds the order-page and /track links off the STOREFRONT origin when one is configured", async () => {
    // config is the parsed env object, mutated here and restored below —
    // the same technique the owner-email suite relies on implicitly by
    // leaving ADMIN_PUBLIC_URL unset.
    const previousShop = config.SHOP_PUBLIC_URL;
    const previousPublic = config.PUBLIC_URL;
    config.SHOP_PUBLIC_URL = "https://shop.example.com/";
    config.PUBLIC_URL = "https://ignored.example.com";
    try {
      await makeSampleUserAGuest();
      const order = await makePendingVerificationOrder(sample.product.id, 1);

      await settlePaidOrder(prisma, order.id, { adminId });

      const payload = JSON.parse((await readyRows(order.id))[0]!.payloadJson) as Record<string, unknown>;
      // Trailing slash on the configured base must not double up.
      expect(payload.order_url).toBe(`https://shop.example.com/checkout/${order.orderCode}/pay`);
      expect(payload.track_url).toBe("https://shop.example.com/track");
    } finally {
      config.SHOP_PUBLIC_URL = previousShop;
      config.PUBLIC_URL = previousPublic;
    }
  });

  it("falls back to PUBLIC_URL when SHOP_PUBLIC_URL is unset", async () => {
    const previousPublic = config.PUBLIC_URL;
    config.PUBLIC_URL = "https://fallback.example.com";
    try {
      await makeSampleUserAGuest();
      const order = await makePendingVerificationOrder(sample.product.id, 1);

      await settlePaidOrder(prisma, order.id, { adminId });

      const payload = JSON.parse((await readyRows(order.id))[0]!.payloadJson) as Record<string, unknown>;
      expect(payload.order_url).toBe(`https://fallback.example.com/checkout/${order.orderCode}/pay`);
      expect(payload.track_url).toBe("https://fallback.example.com/track");
    } finally {
      config.PUBLIC_URL = previousPublic;
    }
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

// E5 item 3: the mirror image of settleWalletTopup's own "not a wallet top-up"
// guard. Without these, a top-up routed to the product-delivery path would
// pass approveOrder's atomic claim, iterate its zero line items, allocate no
// stock and land in DELIVERED with the buyer's money taken and NOTHING
// credited — a silent loss, which is why it is guarded at both doors rather
// than argued to be unreachable.
describe("wallet top-ups cannot be settled through the product-delivery path", () => {
  async function makeTopupOrder(): Promise<number> {
    const order = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "50000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY as never,
    });
    await prisma.order.update({
      where: { id: order.id },
      data: { status: OrderStatus.PENDING_VERIFICATION },
    });
    return order.id;
  }

  it("settlePaidOrder refuses a WALLET_TOPUP order", async () => {
    const orderId = await makeTopupOrder();

    await expect(settlePaidOrder(prisma, orderId, { adminId: 1 })).rejects.toMatchObject({
      key: "error.order_is_wallet_topup",
    });
  });

  it("approveOrder refuses a WALLET_TOPUP order, and leaves its status untouched", async () => {
    const orderId = await makeTopupOrder();

    await expect(approveOrder(prisma, orderId, { adminId: 1 })).rejects.toMatchObject({
      key: "error.order_is_wallet_topup",
    });

    // The claim never ran: still PENDING_VERIFICATION, never DELIVERED, and no
    // status-history row was written for a delivery that did not happen.
    const after = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(after.status).toBe(OrderStatus.PENDING_VERIFICATION);
    expect(after.deliveredAt).toBeNull();
    expect(await prisma.orderStatusHistory.count({ where: { orderId, status: OrderStatus.DELIVERED } })).toBe(0);
  });

  it("still settles an ordinary PRODUCT order — the guard reads kind, not shape", async () => {
    const order = await createOrderDirect(prisma, {
      user: sample.user,
      productId: sample.product.id,
      quantity: 1,
    });
    await prisma.order.update({
      where: { id: order!.id },
      data: { status: OrderStatus.PENDING_VERIFICATION },
    });

    // A real admin row, not a literal: the SOLD stock event this now writes
    // carries actorAdminId under a real FK to User (see this file's `adminId`
    // fixture comment — the same hazard AuditLog.adminId already had).
    const result = await settlePaidOrder(prisma, order!.id, { adminId });

    expect(result.kind).toBe("delivered");
  });
});

// Fase 3b: when the row reserved at checkout is no longer RESERVED by the
// time an admin approves (an admin marked it dead, a supplier revoked it),
// approveOrder pulls a replacement. That swap has to be legible in the
// ledger, or "which credential did this buyer actually get?" has no answer.
describe("approveOrder substitution events", () => {
  it("a reserved row marked dead before approval is substituted out, and the replacement is sold", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 1);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    const deadRowId = item.stockItemId!;
    expect(await markStockDead(prisma, deadRowId, "test: supplier revoked it", sample.user.id)).toBe(1);

    const { credentials } = await approveOrder(prisma, order.id, { adminId });

    // The line now points at a different row, and that row is the one sold.
    const itemAfter = await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(itemAfter.stockItemId).not.toBe(deadRowId);
    const replacement = await prisma.stockItem.findUniqueOrThrow({ where: { id: itemAfter.stockItemId! } });
    expect(replacement.status).toBe(StockStatus.SOLD);
    expect(replacement.soldToOrderId).toBe(order.id);
    expect(replacement.soldToOrderItemId).toBe(item.id);
    expect(replacement.warrantyUntil!.getTime() - replacement.soldAt!.getTime()).toBe(30 * 86_400_000);
    // Warranty replacement is Fase 5e's semantics, not a substitution's.
    expect(replacement.replacesStockItemId).toBeNull();

    // The dead row keeps its status and gains only the swap annotation.
    const deadRow = await prisma.stockItem.findUniqueOrThrow({ where: { id: deadRowId } });
    expect(deadRow.status).toBe(StockStatus.DEAD);
    expect(deadRow.soldToOrderId).toBeNull();

    const outEvents = await prisma.stockItemEvent.findMany({
      where: { orderId: order.id, eventType: StockEventType.SUBSTITUTED_OUT },
    });
    expect(outEvents).toHaveLength(1);
    expect(outEvents[0]).toMatchObject({
      stockItemId: deadRowId,
      orderItemId: item.id,
      actorType: StockActorType.ADMIN,
      actorAdminId: adminId,
    });

    // The replacement's own ledger: reserved by this approval, annotated as
    // the row swapped in, then sold.
    const replacementEvents = await prisma.stockItemEvent.findMany({
      where: { stockItemId: replacement.id },
      orderBy: { id: "asc" },
    });
    expect(replacementEvents.map((e) => e.eventType)).toEqual([
      StockEventType.RESERVED,
      StockEventType.SUBSTITUTED_IN,
      StockEventType.SOLD,
    ]);
    for (const event of replacementEvents) {
      expect(event).toMatchObject({
        orderId: order.id,
        orderItemId: item.id,
        actorType: StockActorType.ADMIN,
        actorAdminId: adminId,
      });
    }

    // The buyer receives the replacement's plaintext credential, decrypted
    // exactly once (it used to be run through decryptCredentials twice and
    // rely on the legacy plaintext passthrough).
    expect(credentials).toEqual([decryptCredentials(replacement.credentials)]);
  });
});
