/**
 * The buyer's one-time payment reminder (PAYMENT_REMINDER_DM, Phase 4 owner
 * decision): which orders qualify when the job enqueues, what the outbox row
 * carries, the once-per-order dedupe, and the send-time re-check the outbox
 * dispatcher runs before it delivers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { NotificationEvent, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { awaitingPaymentNothingObserved } from "@app/core";
import { isPaymentReminderCandidate, listExpiringPendingPayments, paymentReminderSkipReason } from "./orders";
import { enqueuePaymentReminderDm } from "./notifications";
import { createWalletTopupOrder } from "./wallet_topup";

let db: TestDb;
let sample: SampleData;
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await resetDb(db.prisma); sample = await buildSampleData(db.prisma); });

const MIN = 60_000;
const LEAD_MS = 5 * MIN;
const NOW = new Date("2026-10-24T07:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

/** A PENDING_PAYMENT order opened `windowMs` before it expires, `leftMs` from now. */
async function pendingOrder(opts: { windowMs: number; leftMs: number; userId?: number; data?: Record<string, unknown> }) {
  const expiresAt = at(opts.leftMs);
  return db.prisma.order.create({
    data: {
      orderCode: `ORD-REMIND-${Math.random().toString(36).slice(2, 10)}`,
      userId: opts.userId ?? sample.user.id,
      subtotalAmount: "50000",
      totalAmount: "50000",
      status: OrderStatus.PENDING_PAYMENT,
      createdAt: new Date(expiresAt.getTime() - opts.windowMs),
      expiresAt,
      ...opts.data,
    },
    include: { user: true },
  });
}

async function reminderRows(orderId: number) {
  return db.prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.PAYMENT_REMINDER_DM } });
}

describe("isPaymentReminderCandidate (enqueue-time eligibility)", () => {
  it("accepts a Telegram buyer's order whose window is longer than the lead and that still has time left", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN + 30_000 });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(true);
  });

  it("skips an order whose whole window is not longer than the lead — it was opened inside the reminder window", async () => {
    const equal = await pendingOrder({ windowMs: 5 * MIN, leftMs: 4 * MIN });
    const shorter = await pendingOrder({ windowMs: 3 * MIN, leftMs: 2 * MIN });
    expect(isPaymentReminderCandidate(equal, NOW, LEAD_MS)).toBe(false);
    expect(isPaymentReminderCandidate(shorter, NOW, LEAD_MS)).toBe(false);
  });

  it("skips a buyer without a Telegram id (web or guest checkout)", async () => {
    const guest = await db.prisma.user.create({ data: { telegramId: null, referralCode: `guest-${Math.random()}`, isGuest: true } });
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, userId: guest.id });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(false);
  });

  it("skips an order without an expiry", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN });
    expect(isPaymentReminderCandidate({ ...order, expiresAt: null }, NOW, LEAD_MS)).toBe(false);
  });

  it("skips an order with less than a minute left, so the push never lands next to the cancel notice", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 45_000 });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(false);
  });

  it("lists neither a paid order still marked PENDING_PAYMENT nor one that already left PENDING_PAYMENT", async () => {
    const paid = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paymentState: "PAID" } });
    const cancelled = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { status: OrderStatus.CANCELLED } });
    const due = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN });
    const ids = (await listExpiringPendingPayments(db.prisma, NOW, at(LEAD_MS))).map((o) => o.id);
    expect(ids).toContain(due.id);
    expect(ids).not.toContain(paid.id);
    expect(ids).not.toContain(cancelled.id);
  });
});

describe("enqueuePaymentReminderDm", () => {
  it("queues one buyer DM carrying only the order code, deadline, minutes left, chat and language", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN + 30_000 });
    await enqueuePaymentReminderDm(db.prisma, {
      orderId: order.id, orderCode: order.orderCode, telegramId: order.user.telegramId, language: "id", expiresAt: order.expiresAt!, kind: order.kind, now: NOW,
    });
    const rows = await reminderRows(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(`payment_reminder:${order.id}`);
    expect(rows[0]!.channel).toBe("TELEGRAM");
    expect(JSON.parse(rows[0]!.payloadJson)).toEqual({
      chat_id: 42,
      order_code: order.orderCode,
      expires_at: order.expiresAt!.toISOString(),
      minutes_left: 4,
      buyer_language: "id",
      is_wallet_topup: false,
    });
  });

  it("writes a single row however many job ticks (or bot instances) try to queue it", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN + 30_000 });
    const args = { orderId: order.id, orderCode: order.orderCode, telegramId: order.user.telegramId, language: "en", expiresAt: order.expiresAt!, kind: order.kind };
    await enqueuePaymentReminderDm(db.prisma, { ...args, now: NOW });
    await enqueuePaymentReminderDm(db.prisma, { ...args, now: at(MIN) });
    await Promise.all([enqueuePaymentReminderDm(db.prisma, { ...args, now: at(2 * MIN) }), enqueuePaymentReminderDm(db.prisma, { ...args, now: at(2 * MIN) })]);
    const rows = await reminderRows(order.id);
    expect(rows).toHaveLength(1);
    // The first payload stands: a later tick does not rewrite it.
    expect(JSON.parse(rows[0]!.payloadJson).minutes_left).toBe(4);
  });

  it("does nothing for a buyer without a Telegram id", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN });
    await enqueuePaymentReminderDm(db.prisma, {
      orderId: order.id, orderCode: order.orderCode, telegramId: null, language: "en", expiresAt: order.expiresAt!, kind: order.kind, now: NOW,
    });
    expect(await reminderRows(order.id)).toHaveLength(0);
  });

  it("covers wallet top-ups too (shared payment-window config), with the top-up's own order code", async () => {
    const topup = await db.prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "100000", currency: "IDR", method: PaymentMethod.TOKOPAY }));
    expect(topup.kind).toBe(OrderKind.WALLET_TOPUP);
    const now = new Date(topup.expiresAt!.getTime() - 4 * MIN);
    const listed = (await listExpiringPendingPayments(db.prisma, now, new Date(now.getTime() + LEAD_MS))).find((o) => o.id === topup.id);
    expect(listed).toBeDefined();
    expect(isPaymentReminderCandidate(listed!, now, LEAD_MS)).toBe(true);
    await enqueuePaymentReminderDm(db.prisma, {
      orderId: topup.id, orderCode: topup.orderCode, telegramId: listed!.user.telegramId, language: listed!.user.language, expiresAt: topup.expiresAt!, kind: listed!.kind, now,
    });
    const rows = await reminderRows(topup.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({ chat_id: 42, order_code: topup.orderCode, minutes_left: 4, is_wallet_topup: true });
  });
});

describe("paymentReminderSkipReason (send-time re-check)", () => {
  it("lets a still-unpaid order with time left through", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN });
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBeNull();
  });

  it("skips an order that was paid (or delivered) after the reminder was queued", async () => {
    const delivered = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { status: OrderStatus.DELIVERED, paymentState: "PAID" } });
    const paidStillPending = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paymentState: "PAID" } });
    const needsReview = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { walletCreditState: "NEEDS_REVIEW" } });
    expect(await paymentReminderSkipReason(db.prisma, delivered.id, NOW)).toBe("ORDER_NOT_AWAITING_PAYMENT");
    expect(await paymentReminderSkipReason(db.prisma, paidStillPending.id, NOW)).toBe("PAYMENT_ALREADY_RECEIVED");
    expect(await paymentReminderSkipReason(db.prisma, needsReview.id, NOW)).toBe("PAYMENT_ALREADY_RECEIVED");
  });

  it("skips an order that was cancelled after the reminder was queued", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { status: OrderStatus.CANCELLED } });
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBe("ORDER_NOT_AWAITING_PAYMENT");
  });

  it("skips an order whose window has closed or has less than a minute left (a late retry)", async () => {
    const expired = await pendingOrder({ windowMs: 10 * MIN, leftMs: -30_000 });
    const closing = await pendingOrder({ windowMs: 10 * MIN, leftMs: 30_000 });
    const noExpiry = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { expiresAt: null } });
    expect(await paymentReminderSkipReason(db.prisma, expired.id, NOW)).toBe("PAYMENT_WINDOW_CLOSING");
    expect(await paymentReminderSkipReason(db.prisma, closing.id, NOW)).toBe("PAYMENT_WINDOW_CLOSING");
    expect(await paymentReminderSkipReason(db.prisma, noExpiry.id, NOW)).toBe("PAYMENT_WINDOW_CLOSING");
  });

  it("skips an order that no longer exists", async () => {
    expect(await paymentReminderSkipReason(db.prisma, 987_654_321, NOW)).toBe("ORDER_NOT_FOUND");
  });

  it("still sends a reminder queued with exactly the one-minute floor left (one comparator for both halves)", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: MIN });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(true);
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBeNull();
  });
});

/**
 * The double-payment trigger (T5b review finding): a provider that already saw
 * the buyer's transfer moves `paymentState` on while the order status stays
 * PENDING_PAYMENT (`recordProviderPaymentObservation`, orderStatus.ts). A
 * "N minutes left to pay, then it is cancelled" push to that buyer invites a
 * second payment, so only "nothing observed yet" orders may be reminded — at
 * enqueue AND at send, by the one shared `awaitingPaymentNothingObserved`.
 */
describe("a payment the provider already saw is never reminded", () => {
  const SEEN_STATES = ["PAYMENT_DETECTED", "VERIFYING", "UNDERPAID", "FAILED", "EXPIRED", "REFUNDED"];

  it.each(SEEN_STATES)("is not queued for a PENDING_PAYMENT order whose payment state is %s", async (paymentState) => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paymentState } });
    // The shared expiry listing is unchanged (auto-cancel still sees it); the
    // reminder's own eligibility is what turns it away.
    expect((await listExpiringPendingPayments(db.prisma, NOW, at(LEAD_MS))).map((o) => o.id)).toContain(order.id);
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(false);
  });

  it.each(SEEN_STATES)("is skipped at send time as PAYMENT_IN_PROGRESS when the payment state became %s after queueing", async (paymentState) => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(true);
    await db.prisma.order.update({ where: { id: order.id }, data: { paymentState } });
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBe("PAYMENT_IN_PROGRESS");
  });

  it.each([null, "WAITING_PAYMENT"])("still reminds an order whose payment state is %s (nothing observed yet)", async (paymentState) => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paymentState } });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(true);
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBeNull();
  });

  it("skips a still-pending order that already carries a paid-at stamp", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paidAt: at(-MIN) } });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(false);
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBe("PAYMENT_ALREADY_RECEIVED");
  });

  it("skips a still-pending order whose wallet credit awaits review, at enqueue and at send", async () => {
    const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paymentState: "WAITING_PAYMENT", walletCreditState: "NEEDS_REVIEW" } });
    expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(false);
    expect(await paymentReminderSkipReason(db.prisma, order.id, NOW)).toBe("PAYMENT_ALREADY_RECEIVED");
  });

  it("decides enqueue and send with the same predicate for every payment state", async () => {
    for (const paymentState of [null, "WAITING_PAYMENT", "PAID", ...SEEN_STATES]) {
      const order = await pendingOrder({ windowMs: 10 * MIN, leftMs: 4 * MIN, data: { paymentState } });
      const expected = awaitingPaymentNothingObserved(order);
      expect(isPaymentReminderCandidate(order, NOW, LEAD_MS)).toBe(expected);
      expect((await paymentReminderSkipReason(db.prisma, order.id, NOW)) === null).toBe(expected);
    }
  });
});
