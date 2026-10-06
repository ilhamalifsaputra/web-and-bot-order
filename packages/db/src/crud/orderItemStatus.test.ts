/**
 * OrderItem.status + recomputeOrderStatus, end to end (Trustance Phase 1,
 * Task 3).
 *
 * This is the suite the task's whole value proposition rests on. Task 3 adds
 * per-item fulfilment status as a PROVABLE NO-OP SHADOW of the order-level
 * outcome that already existed: `settlePaidOrder` still computes one order-wide
 * `isManual` boolean and takes the same branch it always took, and the new
 * per-item writes ride along inside that branch. So what has to be proven is
 * not that some new behavior works, but that:
 *
 *   1. for every order shape the system can create, all of an order's items
 *      always end up on ONE status, never split;
 *   2. that status always agrees with the Order.status the pre-existing code
 *      wrote;
 *   3. `recomputeOrderStatus` therefore never changes anything — in particular
 *      it never produces PARTIALLY_DELIVERED — and writes no extra
 *      OrderStatusHistory row;
 *   4. a legacy row (null status, the `prisma db push` deploy boundary) still
 *      settles exactly as before.
 *
 * `settlePaidOrder.test.ts` continues to own the behavioral assertions about
 * which branch runs; this file only asserts the shadow tracks them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  createOrderFromCart,
  attachPaymentProof,
  settlePaidOrder,
  fulfillManualOrder,
  recomputeOrderStatus,
  cancelOrder,
  creditOrderToBalance,
} from "./orders";
import { createWalletTopupOrder } from "./wallet_topup";
import { createCategory, createCatalogProduct, createDenomination, updateDenomination } from "./catalog";
import { addToCart } from "./cart";
import { bulkAddStock } from "./stock";
import { DeliveryType, OrderStatus, OrderItemStatus, ProductType, PaymentMethod, StockActorType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";

let db: TestDb;
let prisma: PrismaClient;
let sample: SampleData;
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
      telegramId: BigInt(910_000_000 + Math.floor(Math.random() * 1_000_000)),
      referralCode: `admin-${Math.random()}`,
      role: "ADMIN",
    },
  });
  adminId = admin.id;
});

/** A stock-backed AUTO denomination of its own, so a cart can hold several
 * genuinely different AUTO lines (the multi-item order shape). */
async function makeAutoDenom(price = "7.00", stockCount = 5) {
  const category = await createCategory(prisma, `auto-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Auto Product ${Math.random()}`,
  });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Auto Denom",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price,
  });
  await bulkAddStock(
    prisma,
    denom.id,
    Array.from({ length: stockCount }, (_, i) => `auto${Math.random()}-${i}@example.com:pw`),
  );
  return denom;
}

/** A manual (or manual_with_info) denomination with NO stock rows. Optionally
 * Digiflazz-routed, which is what makes it a top-up. */
async function makeManualDenom(
  deliveryType: string = DeliveryType.MANUAL,
  autoDeliverySource: string | null = null,
) {
  const category = await createCategory(prisma, `manual-cat-${Math.random()}`);
  const product = await createCatalogProduct(prisma, {
    categoryId: category.id,
    name: `Manual Product ${Math.random()}`,
  });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Manual Denom",
    type: ProductType.SHARED,
    durationLabel: "1 Month",
    price: "10.00",
  });
  await updateDenomination(prisma, denom.id, { deliveryType });
  if (autoDeliverySource) {
    // A supplier top-up always carries its target field: checkout refuses a
    // Digiflazz SKU with no input fields, since it could only dispatch an
    // empty customer number.
    await prisma.denomination.update({
      where: { id: denom.id },
      data: {
        autoDeliverySource,
        additionalFields: JSON.stringify([{ key: "user_id", label: { id: "Player ID", en: "Player ID" }, type: "text", required: true, options: [], placeholder: "" }]),
      },
    });
  }
  return denom;
}

async function makePendingVerificationOrder(productId: number, quantity = 1) {
  const denom = await prisma.denomination.findUniqueOrThrow({ where: { id: productId } });
  const customerData = denom.additionalFields ? JSON.stringify(Array.from({ length: quantity }, () => ({ user_id: "12345" }))) : undefined;
  const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId, quantity, customerData });
  await attachPaymentProof(prisma, order!.id, { fileId: "file123", txid: "TX-1" });
  return order!;
}

const itemStatuses = async (orderId: number): Promise<(string | null)[]> =>
  (await prisma.orderItem.findMany({ where: { orderId }, orderBy: { id: "asc" } })).map((i) => i.status);

const historyCount = (orderId: number) => prisma.orderStatusHistory.count({ where: { orderId } });

/**
 * The invariant every order shape below is checked against: the items agree
 * with each other, they agree with the order, and `recomputeOrderStatus` has
 * nothing to say about any of it.
 */
async function expectShadowIsConsistent(orderId: number, expectedItemStatus: string, expectedOrderStatus: string) {
  const statuses = await itemStatuses(orderId);
  expect(statuses.length).toBeGreaterThan(0);
  // (1) never split.
  expect(new Set(statuses).size).toBe(1);
  // (2) tracks the branch's outcome.
  expect(statuses[0]).toBe(expectedItemStatus);

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  expect(order!.status).toBe(expectedOrderStatus);

  // (3) recompute is inert, and provably so: no status change AND no audit row.
  const before = await historyCount(orderId);
  const recomputed = await recomputeOrderStatus(prisma, orderId);
  expect(recomputed).toBeNull();
  const after = await prisma.order.findUnique({ where: { id: orderId } });
  expect(after!.status).toBe(expectedOrderStatus);
  expect(await historyCount(orderId)).toBe(before);
  // The whole point of the deferral: this must not be reachable yet.
  expect(after!.status).not.toBe(OrderStatus.PARTIALLY_DELIVERED);
}

describe("OrderItem.status at creation", () => {
  it("createOrderDirect starts every item PENDING", async () => {
    const order = await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 3 });
    const statuses = await itemStatuses(order!.id);
    expect(statuses).toEqual([OrderItemStatus.PENDING, OrderItemStatus.PENDING, OrderItemStatus.PENDING]);
  });

  it("createOrderFromCart starts every item PENDING, across multiple lines", async () => {
    const second = await makeAutoDenom();
    await addToCart(prisma, sample.user.id, sample.product.id, 2);
    await addToCart(prisma, sample.user.id, second.id, 1);
    const order = await createOrderFromCart(prisma, {
     channel: "bot",
      user: { id: sample.user.id, role: sample.user.role, walletBalance: "0" },
    });
    const statuses = await itemStatuses(order!.id);
    expect(statuses).toHaveLength(3);
    expect(statuses.every((s) => s === OrderItemStatus.PENDING)).toBe(true);
  });
});

describe("settlePaidOrder — the per-item shadow, per order shape", () => {
  it("single-item AUTO order: every item DELIVERED, order DELIVERED, recompute inert", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 1);
    const result = await settlePaidOrder(prisma, order.id, { adminId });

    // Behavior unchanged — the same assertions settlePaidOrder.test.ts makes.
    expect(result.kind).toBe("delivered");
    expect(result.order.status).toBe(OrderStatus.DELIVERED);

    await expectShadowIsConsistent(order.id, OrderItemStatus.DELIVERED, OrderStatus.DELIVERED);
  });

  it("multi-QUANTITY AUTO order: all 3 items DELIVERED together, never a split", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 3);
    await settlePaidOrder(prisma, order.id, { adminId });
    const statuses = await itemStatuses(order.id);
    expect(statuses).toHaveLength(3);
    await expectShadowIsConsistent(order.id, OrderItemStatus.DELIVERED, OrderStatus.DELIVERED);
  });

  // The shape closest to the split this task deliberately does NOT enable:
  // several genuinely different SKUs in one order. They still resolve as one.
  it("multi-LINE all-AUTO cart order: every item across both lines DELIVERED, never a split", async () => {
    const second = await makeAutoDenom();
    await addToCart(prisma, sample.user.id, sample.product.id, 2);
    await addToCart(prisma, sample.user.id, second.id, 2);
    const created = await createOrderFromCart(prisma, {
     channel: "bot",
      user: { id: sample.user.id, role: sample.user.role, walletBalance: "0" },
    });
    await attachPaymentProof(prisma, created!.id, { fileId: "f", txid: "TX-multi" });

    const result = await settlePaidOrder(prisma, created!.id, { adminId });
    expect(result.kind).toBe("delivered");

    const statuses = await itemStatuses(created!.id);
    expect(statuses).toHaveLength(4);
    await expectShadowIsConsistent(created!.id, OrderItemStatus.DELIVERED, OrderStatus.DELIVERED);
  });

  it("single manual item: every item QUEUED, order PROCESSING, recompute inert", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);

    const result = await settlePaidOrder(prisma, order.id, { adminId });
    expect(result.kind).toBe("processing");

    await expectShadowIsConsistent(order.id, OrderItemStatus.QUEUED, OrderStatus.PROCESSING);
  });

  it("manual item at quantity 2: both items QUEUED, never a split", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO);
    const order = await makePendingVerificationOrder(manualDenom.id, 2);
    await settlePaidOrder(prisma, order.id, { adminId });
    expect(await itemStatuses(order.id)).toHaveLength(2);
    await expectShadowIsConsistent(order.id, OrderItemStatus.QUEUED, OrderStatus.PROCESSING);
  });

  // A Digiflazz top-up EXACTLY as the catalog sync creates it: MANUAL_WITH_INFO
  // + autoDeliverySource "digiflazz". It takes the MANUAL branch (it is
  // non-AUTO), so its shadow is QUEUED like any other hand-fulfilled line — the
  // supplier dispatch poller is what moves it on, and that is out of scope here.
  it("Digiflazz top-up order: item QUEUED, order PROCESSING, recompute inert", async () => {
    const topup = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO, "digiflazz");
    const order = await makePendingVerificationOrder(topup.id, 1);

    const result = await settlePaidOrder(prisma, order.id, { adminId });
    expect(result.kind).toBe("processing");

    await expectShadowIsConsistent(order.id, OrderItemStatus.QUEUED, OrderStatus.PROCESSING);
  });
});

describe("fulfillManualOrder — the per-item shadow", () => {
  it("moves every item QUEUED -> DELIVERED alongside the order, recompute inert", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 2);
    await settlePaidOrder(prisma, order.id, { adminId });
    expect((await itemStatuses(order.id)).every((s) => s === OrderItemStatus.QUEUED)).toBe(true);

    await fulfillManualOrder(prisma, order.id, { adminId, content: "user:x pass:y" });

    await expectShadowIsConsistent(order.id, OrderItemStatus.DELIVERED, OrderStatus.DELIVERED);
  });

  it("a rejected double-fulfil leaves the item statuses exactly as the first call left them", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });
    await fulfillManualOrder(prisma, order.id, { adminId, content: "first" });

    await expect(fulfillManualOrder(prisma, order.id, { adminId, content: "second" })).rejects.toBeInstanceOf(
      ValidationError,
    );
    // The per-item write sits BEHIND the atomic claim, so the losing call
    // never reached it.
    await expectShadowIsConsistent(order.id, OrderItemStatus.DELIVERED, OrderStatus.DELIVERED);
  });

  it("a content-validation failure leaves items QUEUED and the order PROCESSING", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });

    await expect(fulfillManualOrder(prisma, order.id, { adminId, content: "   " })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expectShadowIsConsistent(order.id, OrderItemStatus.QUEUED, OrderStatus.PROCESSING);
  });
});

describe("recomputeOrderStatus — the cases where it must refuse to act", () => {
  it("leaves an order whose items predate the column (null status) completely alone", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 1);
    await settlePaidOrder(prisma, order.id, { adminId });
    // Simulate the `prisma db push` deploy boundary: the column exists but was
    // never backfilled, so a historical row is null.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { status: null } });

    const before = await historyCount(order.id);
    expect(await recomputeOrderStatus(prisma, order.id)).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe(OrderStatus.DELIVERED);
    expect(await historyCount(order.id)).toBe(before);
  });

  it("leaves a wallet top-up (an order with no items) alone", async () => {
    const topup = await createWalletTopupOrder(prisma, {
      userId: sample.user.id,
      amount: "50000",
      currency: "IDR",
      method: PaymentMethod.TOKOPAY,
    });
    expect(await prisma.orderItem.count({ where: { orderId: topup.id } })).toBe(0);
    expect(await recomputeOrderStatus(prisma, topup.id)).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: topup.id } });
    expect(after!.status).toBe(OrderStatus.PENDING_PAYMENT);
  });

  it("leaves an unpaid order (items still PENDING) alone", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 2);
    expect((await itemStatuses(order.id)).every((s) => s === OrderItemStatus.PENDING)).toBe(true);
    expect(await recomputeOrderStatus(prisma, order.id)).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe(OrderStatus.PENDING_VERIFICATION);
  });

  it("returns null for an order id that does not exist", async () => {
    expect(await recomputeOrderStatus(prisma, 987_654_321)).toBeNull();
  });

  // KNOWN, DELIBERATE GAP — pinned here so it stays known.
  //
  // Task 3 wired the item-status shadow into the three DELIVERY paths
  // (approveOrder, settlePaidOrder's manual branch, fulfillManualOrder) only.
  // The paths that END an order without delivering it — cancelOrder,
  // rejectOrder, autoCancelExpiredOrders, creditOrderToBalance — still move
  // Order.status while leaving the items at whatever in-flight status they last
  // had. That depends on WHERE the order was cancelled from, so both cases are
  // covered below:
  //
  //   cancelled from PENDING_VERIFICATION -> items still PENDING
  //   cancelled from PROCESSING           -> items still QUEUED
  //
  // The gap was not closed because REJECTED and REFUNDED have no
  // OrderItemStatus counterpart (both deferred with the Refund domain), so
  // mapping them onto CANCELLED would invent information rather than record it.
  //
  // What matters is that the gap is INERT, not merely unfinished: PENDING and
  // QUEUED are BOTH in IN_FLIGHT_ORDER_ITEM_STATUSES, so the derivation
  // declines either way and recompute can never drag a terminal order back out
  // of its state. Nothing in production reads OrderItem.status except
  // recomputeOrderStatus itself. These two tests are the proof.
  it("an order cancelled from PENDING_VERIFICATION keeps items PENDING; recompute refuses to resurrect it", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 2);
    await cancelOrder(prisma, order.id, "test cancellation", { type: StockActorType.SYSTEM });

    const cancelled = await prisma.order.findUnique({ where: { id: order.id } });
    expect(cancelled!.status).toBe(OrderStatus.CANCELLED);
    // The shadow does not (yet) cover this path.
    expect((await itemStatuses(order.id)).every((s) => s === OrderItemStatus.PENDING)).toBe(true);

    const before = await historyCount(order.id);
    expect(await recomputeOrderStatus(prisma, order.id)).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe(OrderStatus.CANCELLED);
    expect(await historyCount(order.id)).toBe(before);
  });

  // NOTE the different entry point. `cancelOrder` REFUSES a PROCESSING order
  // (it is already paid — `assertNotPaidWithoutCredit` throws
  // error.order_paid_needs_credit), so the real way out of the fulfilment queue
  // is `creditOrderToBalance`, which refunds the buyer to store credit and
  // lands the order in CANCELLED. That is the H-2 fix.
  it("an order credited out of PROCESSING keeps items QUEUED; recompute is equally inert", async () => {
    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const order = await makePendingVerificationOrder(manualDenom.id, 2);
    await settlePaidOrder(prisma, order.id, { adminId });
    expect((await itemStatuses(order.id)).every((s) => s === OrderItemStatus.QUEUED)).toBe(true);

    await creditOrderToBalance(prisma, { orderId: order.id, adminId });

    const cancelled = await prisma.order.findUnique({ where: { id: order.id } });
    expect(cancelled!.status).toBe(OrderStatus.CANCELLED);
    // QUEUED, NOT PENDING — the distinction the first version of this comment
    // got wrong.
    expect((await itemStatuses(order.id)).every((s) => s === OrderItemStatus.QUEUED)).toBe(true);

    const before = await historyCount(order.id);
    expect(await recomputeOrderStatus(prisma, order.id)).toBeNull();
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe(OrderStatus.CANCELLED);
    expect(await historyCount(order.id)).toBe(before);
  });
});

/**
 * The deferral, asserted rather than assumed. PARTIALLY_DELIVERED exists in the
 * enum and `deriveOrderStatusFromItems` can produce it — but only from a split
 * set of item statuses, and no code path in this repo can produce one. The
 * first test reaches that state by writing the split BY HAND, which is the
 * point: it takes a direct DB write that no production code performs.
 */
describe("PARTIALLY_DELIVERED is unreachable through any current code path", () => {
  it("no order shape this codebase can settle produces a split set of item statuses", async () => {
    const second = await makeAutoDenom();
    await addToCart(prisma, sample.user.id, sample.product.id, 2);
    await addToCart(prisma, sample.user.id, second.id, 1);
    const cartOrder = await createOrderFromCart(prisma, {
     channel: "bot",
      user: { id: sample.user.id, role: sample.user.role, walletBalance: "0" },
    });
    await attachPaymentProof(prisma, cartOrder!.id, { fileId: "f", txid: "TX-a" });
    await settlePaidOrder(prisma, cartOrder!.id, { adminId });

    const manualDenom = await makeManualDenom(DeliveryType.MANUAL);
    const manualOrder = await makePendingVerificationOrder(manualDenom.id, 2);
    await settlePaidOrder(prisma, manualOrder.id, { adminId });
    await fulfillManualOrder(prisma, manualOrder.id, { adminId, content: "acct" });

    const topupDenom = await makeManualDenom(DeliveryType.MANUAL_WITH_INFO, "digiflazz");
    const topupOrder = await makePendingVerificationOrder(topupDenom.id, 1);
    await settlePaidOrder(prisma, topupOrder.id, { adminId });

    for (const id of [cartOrder!.id, manualOrder.id, topupOrder.id]) {
      expect(new Set(await itemStatuses(id)).size).toBe(1);
      expect(await recomputeOrderStatus(prisma, id)).toBeNull();
    }

    // And nothing in the whole database ended up in that status.
    expect(await prisma.order.count({ where: { status: OrderStatus.PARTIALLY_DELIVERED } })).toBe(0);
  });

  // Proves the machinery is real and not dead code — it does work, there is
  // simply nothing today that feeds it a split order.
  it("but a hand-written split DOES derive it, so the foundation is genuinely in place", async () => {
    const order = await makePendingVerificationOrder(sample.product.id, 2);
    await settlePaidOrder(prisma, order.id, { adminId });
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } });
    // A direct write of the kind no production code path performs.
    await prisma.orderItem.update({ where: { id: items[1]!.id }, data: { status: OrderItemStatus.FAILED } });

    // The order is DELIVERED (a terminal state), so the transition is refused
    // and nothing is written — recompute reports it did not apply.
    expect(await recomputeOrderStatus(prisma, order.id)).toBeNull();
    const stillDelivered = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stillDelivered!.status).toBe(OrderStatus.DELIVERED);

    // From an in-flight status the same split DOES land, which is what a future
    // plan will rely on.
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.PROCESSING } });
    expect(await recomputeOrderStatus(prisma, order.id)).toBe(OrderStatus.PARTIALLY_DELIVERED);
    const recomputed = await prisma.order.findUnique({ where: { id: order.id } });
    expect(recomputed!.status).toBe(OrderStatus.PARTIALLY_DELIVERED);
  });
});
