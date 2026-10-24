/**
 * The buyer's one-time expiry push (ORDER_EXPIRED_DM, Phase 4 owner decision):
 * the expiry sweep's own cancel (`cancelExpiredPendingOrder`), which queues the
 * push in the cancel transaction when the order's tracked progress message
 * will only be edited silently, what the outbox row carries, the once-per-order
 * dedupe, and the send-time re-check the outbox dispatcher runs before it
 * delivers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { NotificationEvent, OrderKind, OrderStatus, PaymentMethod, StockActorType } from "@app/core/enums";
import { cancelExpiredPendingOrder, cancelOrder, orderExpiredDmSkipReason } from "./orders";
import { enqueueOrderExpiredDm } from "./notifications";
import { transactionMessageCancelNotice } from "./fulfillmentMessages";
import { createWalletTopupOrder } from "./wallet_topup";

let db: TestDb;
let sample: SampleData;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await resetDb(db.prisma); sample = await buildSampleData(db.prisma); });

/** A PENDING_PAYMENT order whose window already lapsed. */
async function expiredOrder(opts: { userId?: number; data?: Record<string, unknown> } = {}) {
  return db.prisma.order.create({
    data: {
      orderCode: `ORD-EXPIRE-${Math.random().toString(36).slice(2, 10)}`,
      userId: opts.userId ?? sample.user.id,
      subtotalAmount: "50000",
      totalAmount: "50000",
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: new Date(Date.now() - 60_000),
      ...opts.data,
    },
  });
}

const pushRows = (orderId: number) =>
  db.prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.ORDER_EXPIRED_DM } });

const track = (orderId: number, data: { messageId?: number | null; messageKind?: string | null; state?: string }) =>
  db.prisma.fulfillmentMessage.create({
    data: { orderId, chatId: 42n, messageId: data.messageId ?? null, messageKind: data.messageKind ?? null, state: data.state ?? "WAITING" },
  });

describe("enqueueOrderExpiredDm", () => {
  it("queues one buyer DM carrying only the chat, order code, language and whether it was a wallet top-up", async () => {
    const order = await expiredOrder();
    await enqueueOrderExpiredDm(db.prisma, { orderId: order.id, orderCode: order.orderCode, telegramId: 42n, language: "id", kind: OrderKind.PRODUCT });
    const rows = await pushRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`order_expired:${order.id}`);
    expect(rows[0]!.channel).toBe("TELEGRAM");
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      chat_id: 42, order_code: order.orderCode, buyer_language: "id", is_wallet_topup: false,
    });
  });

  it("writes a single row however many times (or bot instances) queue it", async () => {
    const order = await expiredOrder();
    const args = { orderId: order.id, orderCode: order.orderCode, telegramId: 42n, language: "en", kind: OrderKind.PRODUCT };
    await enqueueOrderExpiredDm(db.prisma, args);
    await Promise.all([enqueueOrderExpiredDm(db.prisma, args), enqueueOrderExpiredDm(db.prisma, args)]);
    expect(await pushRows(order.id)).toHaveLength(1);
  });

  it("does nothing for a buyer without a Telegram id (web or guest checkout)", async () => {
    const order = await expiredOrder();
    await enqueueOrderExpiredDm(db.prisma, { orderId: order.id, orderCode: order.orderCode, telegramId: null, language: "en", kind: OrderKind.PRODUCT });
    expect(await pushRows(order.id)).toHaveLength(0);
  });

  it("marks a wallet top-up as one, so its text leaves out the stock line", async () => {
    const order = await expiredOrder({ data: { kind: OrderKind.WALLET_TOPUP } });
    await enqueueOrderExpiredDm(db.prisma, { orderId: order.id, orderCode: order.orderCode, telegramId: 42n, language: "en", kind: OrderKind.WALLET_TOPUP });
    expect(JSON.parse((await pushRows(order.id))[0]!.payloadJson).is_wallet_topup).toBe(true);
  });
});

describe("transactionMessageCancelNotice (what the progress message does when the order ends)", () => {
  it("reports an order with no tracked message as untracked", async () => {
    const order = await expiredOrder();
    expect(await transactionMessageCancelNotice(db.prisma, order.id)).toBe("untracked");
  });

  it("reports a tracked text message as edited silently — Telegram makes no sound for an edit", async () => {
    const order = await expiredOrder();
    await track(order.id, { messageId: 700, messageKind: "text" });
    expect(await transactionMessageCancelNotice(db.prisma, order.id)).toBe("silent");
  });

  it("reports a tracked QR photo as a new message — the worker retires it by sending a fresh status text", async () => {
    for (const state of ["WAITING", "ACTIVE", "READY", "REVIEW", "EDITING"]) {
      const order = await expiredOrder();
      await track(order.id, { messageId: 700 + Math.floor(Math.random() * 1e6), messageKind: "photo", state });
      expect(await transactionMessageCancelNotice(db.prisma, order.id)).toBe("new_message");
    }
  });

  it("treats a legacy message of unknown kind as a possible photo, so it never risks a second message", async () => {
    const order = await expiredOrder();
    await track(order.id, { messageId: 701, messageKind: null });
    expect(await transactionMessageCancelNotice(db.prisma, order.id)).toBe("new_message");
  });

  it("reports silence when the worker will send nothing: no message yet, or a message it stopped handling", async () => {
    const noMessage = await expiredOrder();
    await track(noMessage.id, { messageId: null, state: "WAITING_SCREEN" });
    expect(await transactionMessageCancelNotice(db.prisma, noMessage.id)).toBe("silent");
    const ready = await expiredOrder();
    await track(ready.id, { messageId: null, state: "READY" });
    expect(await transactionMessageCancelNotice(db.prisma, ready.id)).toBe("silent");
    for (const state of ["STOPPED", "UNCERTAIN", "FINISHED", "SENDING"]) {
      const order = await expiredOrder();
      await track(order.id, { messageId: 800 + Math.floor(Math.random() * 1e6), messageKind: "photo", state });
      expect(await transactionMessageCancelNotice(db.prisma, order.id)).toBe("silent");
    }
  });
});

describe("cancelExpiredPendingOrder", () => {
  it("cancels the order and, for a tracked text message, queues the push in the same transaction", async () => {
    const order = await expiredOrder();
    await track(order.id, { messageId: 700, messageKind: "text" });
    const result = await cancelExpiredPendingOrder(db.prisma, order.id);
    expect(result).toEqual({ cancelled: true, tracked: true });
    expect((await db.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
    expect(await pushRows(order.id)).toHaveLength(1);
  });

  it("queues nothing for a tracked QR photo, whose retirement already sends the buyer a new message", async () => {
    const order = await expiredOrder();
    await track(order.id, { messageId: 700, messageKind: "photo" });
    expect(await cancelExpiredPendingOrder(db.prisma, order.id)).toEqual({ cancelled: true, tracked: true });
    expect(await pushRows(order.id)).toHaveLength(0);
  });

  it("leaves an untracked order's push to the caller, which first learns what its Telegram edit did", async () => {
    const order = await expiredOrder();
    expect(await cancelExpiredPendingOrder(db.prisma, order.id)).toEqual({ cancelled: true, tracked: false });
    expect(await pushRows(order.id)).toHaveLength(0);
  });

  it("does nothing to an order the buyer cancelled first — no expiry push for someone else's cancellation", async () => {
    const order = await expiredOrder();
    await track(order.id, { messageId: 700, messageKind: "text" });
    await cancelOrder(db.prisma, order.id, "user_cancelled", { type: StockActorType.CUSTOMER, customerId: sample.user.id });
    expect(await cancelExpiredPendingOrder(db.prisma, order.id)).toEqual({ cancelled: false });
    expect(await pushRows(order.id)).toHaveLength(0);
    const history = await db.prisma.orderStatusHistory.findMany({ where: { orderId: order.id, status: OrderStatus.CANCELLED } });
    expect(history.map((h) => h.meta)).toEqual(["user_cancelled"]);
  });

  it("queues nothing for a web or guest buyer", async () => {
    const guest = await db.prisma.user.create({ data: { telegramId: null, referralCode: `guest-${Math.random()}`, isGuest: true } });
    const order = await expiredOrder({ userId: guest.id });
    expect(await cancelExpiredPendingOrder(db.prisma, order.id)).toEqual({ cancelled: true, tracked: false });
    expect(await pushRows(order.id)).toHaveLength(0);
  });

  it("cancels a tracked wallet top-up and queues its push too", async () => {
    const topup = await db.prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "100000", currency: "IDR", method: PaymentMethod.TOKOPAY }));
    await db.prisma.fulfillmentMessage.upsert({
      where: { orderId: topup.id },
      create: { orderId: topup.id, chatId: 42n, messageId: 900, messageKind: "text", state: "WAITING" },
      update: { messageId: 900, messageKind: "text", state: "WAITING" },
    });
    expect(await cancelExpiredPendingOrder(db.prisma, topup.id)).toEqual({ cancelled: true, tracked: true });
    const rows = await pushRows(topup.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({ order_code: topup.orderCode, is_wallet_topup: true });
  });
});

describe("orderExpiredDmSkipReason (send-time re-check)", () => {
  it("lets a still-cancelled, unpaid order through", async () => {
    const order = await expiredOrder({ data: { status: OrderStatus.CANCELLED } });
    expect(await orderExpiredDmSkipReason(db.prisma, order.id)).toBeNull();
  });

  it("skips an order that left CANCELLED — a late top-up payment re-opened and credited it", async () => {
    const order = await expiredOrder({ data: { kind: OrderKind.WALLET_TOPUP, status: OrderStatus.DELIVERED, paymentState: "PAID", walletCreditState: "CREDITED" } });
    expect(await orderExpiredDmSkipReason(db.prisma, order.id)).toBe("ORDER_NOT_CANCELLED");
  });

  it("skips a cancelled order on which money was seen after all", async () => {
    for (const data of [{ paymentState: "PAID" }, { paymentState: "UNDERPAID" }, { paymentState: "PAYMENT_DETECTED" }, { paymentState: "VERIFYING" }, { walletCreditState: "CREDITED" }, { walletCreditState: "NEEDS_REVIEW" }]) {
      const order = await expiredOrder({ data: { status: OrderStatus.CANCELLED, ...data } });
      expect(await orderExpiredDmSkipReason(db.prisma, order.id)).toBe("PAYMENT_ALREADY_RECEIVED");
    }
  });

  it("names a missing order", async () => {
    expect(await orderExpiredDmSkipReason(db.prisma, 987_654_321)).toBe("ORDER_NOT_FOUND");
  });
});
