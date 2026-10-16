/**
 * A notification that cannot be queued must never un-pay an order (backend
 * audit pass 2, A3).
 *
 * `settlePaidOrder` (and the `approveOrder` it calls for stock orders) runs
 * inside the payment rail's `$transaction`, after the gateway already took the
 * buyer's money. The owner/buyer emails, the processing DM and the admin alert
 * it queues are side effects: if one of them fails, the payment, the stock sale
 * and the ledger posting must still commit, and the failure is only logged.
 *
 * Two failure shapes are covered, because they need different protection:
 * - a JavaScript throw from the enqueue helper (stubbed below);
 * - a database error from the outbox INSERT itself (a trigger below). In
 *   Postgres a failed statement aborts the whole transaction, so catching the
 *   JS error is not enough — every later statement would fail with "current
 *   transaction is aborted" unless the enqueue ran behind a savepoint.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { settlePaidOrder, createOrderDirect, attachPaymentProof } from "./orders";
import { createCategory, createCatalogProduct, createDenomination, updateDenomination } from "./catalog";
import { transitionOrderStatus } from "./orderStatus";
import { addAdminIdToDb } from "./admins";
import { DeliveryType, NotificationEvent, OrderStatus, StockStatus } from "@app/core/enums";
import { logger } from "@app/core/logger";

const faults = vi.hoisted(() => ({ throwIn: new Set<string>() }));

vi.mock("./notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./notifications")>();
  const wrap = <F extends (...args: never[]) => Promise<unknown>>(name: string, fn: F) =>
    (async (...args: Parameters<F>) => {
      if (faults.throwIn.has(name)) throw new Error(`simulated ${name} failure`);
      return fn(...args);
    }) as F;
  return {
    ...actual,
    enqueueOwnerOrderPaidEmail: wrap("enqueueOwnerOrderPaidEmail", actual.enqueueOwnerOrderPaidEmail),
    enqueueBuyerOrderReadyEmail: wrap("enqueueBuyerOrderReadyEmail", actual.enqueueBuyerOrderReadyEmail),
    enqueueOrderProcessingDm: wrap("enqueueOrderProcessingDm", actual.enqueueOrderProcessingDm),
    enqueueManualOrderAdminAlert: wrap("enqueueManualOrderAdminAlert", actual.enqueueManualOrderAdminAlert),
    enqueueOwnerManualQueueEmail: wrap("enqueueOwnerManualQueueEmail", actual.enqueueOwnerManualQueueEmail),
  };
});
vi.mock("./emailEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./emailEvents")>();
  return {
    ...actual,
    enqueueOrderEmailFact: async (...args: Parameters<typeof actual.enqueueOrderEmailFact>) => {
      if (faults.throwIn.has("enqueueOrderEmailFact")) throw new Error("simulated enqueueOrderEmailFact failure");
      return actual.enqueueOrderEmailFact(...args);
    },
    enqueueOrderTransitionEmails: async (...args: Parameters<typeof actual.enqueueOrderTransitionEmails>) => {
      if (faults.throwIn.has("enqueueOrderTransitionEmails")) throw new Error("simulated enqueueOrderTransitionEmails failure");
      return actual.enqueueOrderTransitionEmails(...args);
    },
  };
});

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
  faults.throwIn.clear();
  await resetDb(prisma);
  sample = await buildSampleData(prisma);
  await addAdminIdToDb(prisma, 987654321);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS reject_outbox_event ON notification_outbox");
  await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS reject_outbox_event()");
});

/** Make the outbox INSERT itself fail, in the database, for these event names. */
async function rejectOutboxEvents(events: string[]) {
  const list = events.map((e) => `'${e}'`).join(", ");
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION reject_outbox_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ` +
      `IF NEW.event IN (${list}) THEN RAISE EXCEPTION 'simulated outbox insert failure for %', NEW.event; END IF; ` +
      `RETURN NEW; END $$`,
  );
  await prisma.$executeRawUnsafe(
    "CREATE TRIGGER reject_outbox_event BEFORE INSERT ON notification_outbox FOR EACH ROW EXECUTE FUNCTION reject_outbox_event()",
  );
}

async function makeManualDenom() {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, { categoryId: category.id, name: `Manual Product ${Math.random()}` });
  const denom = await createDenomination(prisma, {
    productId: product.id, name: "Manual Denom", type: "SHARED", durationLabel: "1 Month", price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType: DeliveryType.MANUAL });
  return denom;
}

async function pendingVerificationOrder(productId: number) {
  const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId, quantity: 1 });
  await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: `TX-${order!.id}` });
  return order!;
}

/** Settle exactly the way a payment rail does: inside its own transaction. */
function settleInRailTransaction(orderId: number) {
  return prisma.$transaction((tx) => settlePaidOrder(tx, orderId, { adminId: 0 }));
}

async function expectAutoOrderPaidAndDelivered(orderId: number) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order.status).toBe(OrderStatus.DELIVERED);
  expect(order.paidAt).not.toBeNull();
  expect(order.paymentState).toBe("PAID");
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId }, include: { stockItem: true } });
  expect(item.stockItem!.status).toBe(StockStatus.SOLD);
  expect(await prisma.orderStatusHistory.count({ where: { orderId, status: OrderStatus.DELIVERED } })).toBe(1);
  expect(await prisma.financialTransaction.count({ where: { idempotencyKey: `order:${orderId}:payment` } })).toBe(1);
}

async function expectManualOrderPaidAndQueued(orderId: number) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(order.status).toBe(OrderStatus.PROCESSING);
  expect(order.paidAt).not.toBeNull();
  expect(order.paymentState).toBe("PAID");
  expect((await prisma.orderItem.findMany({ where: { orderId } })).every((it) => it.status === "QUEUED")).toBe(true);
  expect(await prisma.orderStatusHistory.count({ where: { orderId, status: OrderStatus.PROCESSING } })).toBe(1);
  expect(await prisma.financialTransaction.count({ where: { idempotencyKey: `order:${orderId}:payment` } })).toBe(1);
}

describe("settlePaidOrder: notification enqueue failures never roll back the payment", () => {
  it("stock order: every enqueue helper throws, the order still commits DELIVERED with stock sold and revenue posted", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { email: "buyer@example.com" } });
    const order = await pendingVerificationOrder(sample.product.id);
    faults.throwIn = new Set(["enqueueOwnerOrderPaidEmail", "enqueueBuyerOrderReadyEmail", "enqueueOrderEmailFact"]);
    const errorLog = vi.spyOn(logger, "error");

    const result = await settleInRailTransaction(order.id);

    expect(result.kind).toBe("delivered");
    expect(result.credentials).toHaveLength(1);
    await expectAutoOrderPaidAndDelivered(order.id);
    // Each swallowed failure is logged, with the order id in the metadata.
    const logged = errorLog.mock.calls.filter(([meta]) => (meta as { orderId?: number })?.orderId === order.id);
    expect(logged.length).toBeGreaterThanOrEqual(3);
  });

  it("stock order: one failing enqueue does not drop the others", async () => {
    await prisma.user.update({ where: { id: sample.user.id }, data: { email: "buyer@example.com" } });
    const order = await pendingVerificationOrder(sample.product.id);
    faults.throwIn = new Set(["enqueueOwnerOrderPaidEmail"]);

    await settleInRailTransaction(order.id);

    await expectAutoOrderPaidAndDelivered(order.id);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: "payment.confirmed.customer" } })).toBe(1);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: NotificationEvent.BUYER_EMAIL_ORDER_READY } })).toBe(1);
  });

  it("stock order: the outbox INSERT fails in the database, the order still commits DELIVERED", async () => {
    const order = await pendingVerificationOrder(sample.product.id);
    await rejectOutboxEvents(["payment.confirmed.customer", "order.completed.customer"]);

    const result = await settleInRailTransaction(order.id);

    expect(result.kind).toBe("delivered");
    await expectAutoOrderPaidAndDelivered(order.id);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: { in: ["payment.confirmed.customer", "order.completed.customer"] } } })).toBe(0);
  });

  it("manual order: every enqueue helper throws, the order still commits PROCESSING as paid with revenue posted", async () => {
    const denom = await makeManualDenom();
    const order = await pendingVerificationOrder(denom.id);
    faults.throwIn = new Set([
      "enqueueOrderEmailFact", "enqueueOrderProcessingDm", "enqueueManualOrderAdminAlert", "enqueueOwnerManualQueueEmail",
    ]);

    const result = await settleInRailTransaction(order.id);

    expect(result.kind).toBe("processing");
    await expectManualOrderPaidAndQueued(order.id);
  });

  it("manual order: the outbox INSERT fails in the database, the order still commits and later enqueues still land", async () => {
    const denom = await makeManualDenom();
    const order = await pendingVerificationOrder(denom.id);
    await rejectOutboxEvents(["payment.confirmed.customer", NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED]);

    const result = await settleInRailTransaction(order.id);

    expect(result.kind).toBe("processing");
    await expectManualOrderPaidAndQueued(order.id);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: NotificationEvent.ADMIN_MANUAL_ORDER_QUEUED } })).toBe(0);
    // Queued before and after the failed INSERTs, in the same transaction.
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: NotificationEvent.ORDER_PROCESSING_DM } })).toBe(1);
  });
});

describe("transitionOrderStatus: transition emails never roll back the status move", () => {
  it("a database error queueing the underpaid emails still commits UNDERPAID with its history row", async () => {
    const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 });
    await rejectOutboxEvents(["payment.underpaid.customer"]);

    await prisma.$transaction((tx) =>
      transitionOrderStatus(tx, { orderId: order!.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.UNDERPAID }),
    );

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order!.id } });
    expect(fresh.status).toBe(OrderStatus.UNDERPAID);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order!.id, status: OrderStatus.UNDERPAID } })).toBe(1);
  });

  it("a thrown enqueue error still commits the move (top-level client)", async () => {
    const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1 });
    faults.throwIn = new Set(["enqueueOrderTransitionEmails"]);

    await transitionOrderStatus(prisma, { orderId: order!.id, from: OrderStatus.PENDING_PAYMENT, to: OrderStatus.FAILED });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order!.id } })).status).toBe(OrderStatus.FAILED);
  });
});
