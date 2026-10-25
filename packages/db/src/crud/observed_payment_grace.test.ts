/**
 * The grace window for a payment a provider has already observed (follow-up
 * item 1). NOWPayments reports a payment while it is still confirming
 * (`recordProviderPaymentObservation` -> paymentState PAYMENT_DETECTED or
 * VERIFYING, status still PENDING_PAYMENT). Cancelling such an order the
 * moment its window lapses stranded the buyer's money, so for
 * `OBSERVED_PAYMENT_GRACE_MS` after expiresAt the expiry sweep neither lists
 * nor cancels it and the NOWPayments poller keeps checking it. After the grace
 * window it is cancelled as before, and every admin is told once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import { NotificationEvent, OrderKind, OrderStatus, PaymentMethod } from "@app/core/enums";
import { OBSERVED_PAYMENT_GRACE_MS, paymentObservedInFlight } from "@app/core";
import { cancelExpiredPendingOrder, countExpiredPending, listExpiredPendingOrders } from "./orders";
import { listPendingNowpaymentsOrders } from "./nowpayments";
import { resolveAdminIds, ADMIN_IDS_KEY } from "./admins";
import { setSetting, __clearSettingsCacheForTests } from "./settings";

let db: TestDb;
let sample: SampleData;
let admins: number[];
beforeAll(async () => { db = await makeTestDb(); });
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  await resetDb(db.prisma);
  sample = await buildSampleData(db.prisma);
  await setSetting(db.prisma, ADMIN_IDS_KEY, "7201,7202");
  __clearSettingsCacheForTests(db.prisma);
  admins = (await resolveAdminIds(db.prisma)).sort((a, b) => a - b);
});

const MIN = 60_000;

async function order(opts: { expiredAgoMs: number; data?: Record<string, unknown> }) {
  return db.prisma.order.create({
    data: {
      orderCode: `ORD-GRACE-${Math.random().toString(36).slice(2, 10)}`,
      userId: sample.user.id,
      subtotalAmount: "5",
      totalAmount: "5",
      currency: "USDT",
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.NOWPAYMENTS,
      expiresAt: new Date(Date.now() - opts.expiredAgoMs),
      ...opts.data,
    },
  });
}

const alertRows = (orderId: number) =>
  db.prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.ADMIN_UNCONFIRMABLE_PAYMENT } });
const statusOf = async (id: number) => (await db.prisma.order.findUniqueOrThrow({ where: { id } })).status;
const listedIds = async (now = new Date()) => (await listExpiredPendingOrders(db.prisma, now)).map((o) => o.id);

describe("paymentObservedInFlight", () => {
  it("is true only for the two states a provider writes while the payment is still confirming", () => {
    expect(paymentObservedInFlight("PAYMENT_DETECTED")).toBe(true);
    expect(paymentObservedInFlight("VERIFYING")).toBe(true);
    for (const s of [null, undefined, "WAITING_PAYMENT", "PAID", "UNDERPAID", "FAILED", "EXPIRED", "REFUNDED"]) {
      expect(paymentObservedInFlight(s), String(s)).toBe(false);
    }
    expect(OBSERVED_PAYMENT_GRACE_MS).toBe(30 * MIN);
  });
});

describe("the expiry sweep inside the grace window", () => {
  it("does not list or count an observed product order, but still lists one nobody paid", async () => {
    const detected = await order({ expiredAgoMs: MIN, data: { paymentState: "PAYMENT_DETECTED" } });
    const verifying = await order({ expiredAgoMs: 29 * MIN, data: { paymentState: "VERIFYING" } });
    const unpaid = await order({ expiredAgoMs: MIN });
    const waiting = await order({ expiredAgoMs: MIN, data: { paymentState: "WAITING_PAYMENT" } });
    const ids = await listedIds();
    expect(ids).not.toContain(detected.id);
    expect(ids).not.toContain(verifying.id);
    expect(ids.sort()).toEqual([unpaid.id, waiting.id].sort());
    expect(await countExpiredPending(db.prisma, new Date())).toBe(2);
  });

  it("refuses to cancel an observed order it reached anyway (listed before the observation landed)", async () => {
    const o = await order({ expiredAgoMs: MIN, data: { paymentState: "VERIFYING" } });
    expect(await cancelExpiredPendingOrder(db.prisma, o.id)).toEqual({ cancelled: false, reason: "payment_in_flight" });
    expect(await statusOf(o.id)).toBe(OrderStatus.PENDING_PAYMENT);
    expect(await db.prisma.notificationOutbox.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("leaves wallet top-ups as they were: listed and cancelled, since a late payment still settles them", async () => {
    const topup = await order({ expiredAgoMs: MIN, data: { kind: OrderKind.WALLET_TOPUP, paymentState: "PAYMENT_DETECTED" } });
    expect(await listedIds()).toContain(topup.id);
    expect(await cancelExpiredPendingOrder(db.prisma, topup.id)).toMatchObject({ cancelled: true });
    expect(await alertRows(topup.id)).toHaveLength(0);
  });

  it("still never lists a paid order or one whose wallet credit awaits review", async () => {
    const paid = await order({ expiredAgoMs: 40 * MIN, data: { paymentState: "PAID" } });
    const review = await order({ expiredAgoMs: 40 * MIN, data: { walletCreditState: "NEEDS_REVIEW" } });
    const ids = await listedIds();
    expect(ids).not.toContain(paid.id);
    expect(ids).not.toContain(review.id);
  });
});

describe("the expiry sweep after the grace window", () => {
  it("lists and cancels the observed order and tells each admin once that it never finished confirming", async () => {
    const o = await order({ expiredAgoMs: 31 * MIN, data: { paymentState: "PAYMENT_DETECTED" } });
    expect(await listedIds()).toContain(o.id);
    expect(await cancelExpiredPendingOrder(db.prisma, o.id)).toMatchObject({ cancelled: true });
    expect(await statusOf(o.id)).toBe(OrderStatus.CANCELLED);
    expect(await cancelExpiredPendingOrder(db.prisma, o.id)).toEqual({ cancelled: false });
    const rows = await alertRows(o.id);
    expect(rows.map((r) => (JSON.parse(r.payloadJson) as { chat_id: number }).chat_id).sort((a, b) => a - b)).toEqual(admins);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(admins.map((a) => `unconfirmable-payment:still_confirming:${o.id}:${a}`).sort());
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({ order_code: o.orderCode, gateway: "NOWPayments", reason: "still_confirming" });
  });

  it("measures the grace window from the caller's clock", async () => {
    const o = await order({ expiredAgoMs: MIN, data: { paymentState: "VERIFYING" } });
    const later = new Date(Date.now() + 30 * MIN);
    expect(await listedIds(later)).toContain(o.id);
    expect(await cancelExpiredPendingOrder(db.prisma, o.id, later)).toMatchObject({ cancelled: true });
    expect(await alertRows(o.id)).toHaveLength(admins.length);
  });

  it("cancels an order nobody paid exactly as before, with no admin alert", async () => {
    const o = await order({ expiredAgoMs: MIN });
    expect(await cancelExpiredPendingOrder(db.prisma, o.id)).toEqual({ cancelled: true, tracked: false });
    expect(await alertRows(o.id)).toHaveLength(0);
  });
});

describe("listPendingNowpaymentsOrders during the grace window", () => {
  it("keeps polling an observed product order until its grace window ends, and nothing else past expiry", async () => {
    const live = await order({ expiredAgoMs: -5 * MIN });
    const inGrace = await order({ expiredAgoMs: 10 * MIN, data: { paymentState: "VERIFYING" } });
    const pastGrace = await order({ expiredAgoMs: 31 * MIN, data: { paymentState: "VERIFYING" } });
    const expiredUnpaid = await order({ expiredAgoMs: MIN });
    const review = await order({ expiredAgoMs: 10 * MIN, data: { paymentState: "VERIFYING", walletCreditState: "NEEDS_REVIEW" } });
    const topup = await order({ expiredAgoMs: 10 * MIN, data: { kind: OrderKind.WALLET_TOPUP, paymentState: "VERIFYING" } });
    const ids = (await listPendingNowpaymentsOrders(db.prisma, new Date())).map((o) => o.id);
    expect(ids.sort()).toEqual([live.id, inGrace.id].sort());
    expect(ids).not.toContain(pastGrace.id);
    expect(ids).not.toContain(expiredUnpaid.id);
    expect(ids).not.toContain(review.id);
    expect(ids).not.toContain(topup.id);
  });
});
