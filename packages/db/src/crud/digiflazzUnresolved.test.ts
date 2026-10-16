/**
 * Backend audit A5: a Digiflazz order still Pending (or still failing
 * transiently) after the 24h backoff window is NOT a definite failure — the
 * supplier may still complete it. It moves to the still-locked
 * "unresolved_at_supplier" state instead of "failed": credit, refund and manual
 * fulfilment stay refused, the poller keeps checking on a slow cadence, and only
 * the supplier's own answer or an audited admin override takes it out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const digiflazzMock = vi.hoisted(() => ({ createTransaction: vi.fn(), getPriceList: vi.fn() }));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzMock.createTransaction,
  getPriceList: digiflazzMock.getPriceList,
}));

import { makeTestDb, type TestDb } from "../../../../tests/helpers/testdb";
import { buildSampleData, resetDb, type SampleData } from "../../../../tests/helpers/sampleData";
import {
  createOrderDirect,
  setSetting,
  deleteSetting,
  ADMIN_IDS_KEY,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS,
  dispatchPendingDigiflazzOrders,
  markDigiflazzOrderFailedByAdmin,
  isDigiflazzInFlight,
  isDigiflazzCreditLocked,
  computeOrderEligibility,
  creditOrderToBalance,
  fulfillManualOrder,
  countAwaitingManualFulfillment,
} from "@app/db";
import { DIGIFLAZZ_STATUS_UNRESOLVED } from "@app/core/orderFulfillment";
import { OrderStatus, DeliveryType, NotificationEvent } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  digiflazzMock.createTransaction.mockReset();
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
  await setSetting(prisma, ADMIN_IDS_KEY, "555");
});

/** A paid Digiflazz order already handed to the supplier, `dispatchedAgoMs`
 * ago, in `status`, with a recheck due now. */
async function makeDispatchedOrder(opts: { dispatchedAgoMs: number; status?: string; attempts?: number; nextRecheckAt?: Date }) {
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
    channel: "bot",
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
    customerData: JSON.stringify([{ user_id: "123456789" }]),
  }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: OrderStatus.PROCESSING,
      paidAt: new Date(Date.now() - opts.dispatchedAgoMs),
      digiflazzDispatchedAt: new Date(Date.now() - opts.dispatchedAgoMs),
      digiflazzAttempts: opts.attempts ?? 20,
      digiflazzStatus: opts.status ?? "pending_at_supplier",
      digiflazzNextRecheckAt: opts.nextRecheckAt ?? new Date(Date.now() - 60_000),
    },
  });
  return order;
}

const pending = (refId: string) => ({ refId, status: "Pending", sn: null, message: null, price: null });
const reloaded = (id: number) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    include: { items: { select: { deliveryTypeSnapshot: true, product: { select: { autoDeliverySource: true, deliveryType: true } } } } },
  });
const reviewAlerts = (orderId: number) =>
  prisma.notificationOutbox.findMany({ where: { orderId, event: NotificationEvent.ORDER_PIPELINE_FAILED } });

describe("exhausted 24h window -> unresolved_at_supplier (still locked)", () => {
  it("a Pending answer after the 24h window keeps the order locked instead of failing it", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 25 * HOUR });
    digiflazzMock.createTransaction.mockResolvedValue(pending(order.orderCode));

    const before = Date.now();
    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzAttempts).toBe(21);
    // Next slow recheck: 6 hours out.
    expect(row.digiflazzNextRecheckAt!.getTime()).toBeGreaterThanOrEqual(before + 6 * HOUR - 1_000);
    expect(row.digiflazzNextRecheckAt!.getTime()).toBeLessThanOrEqual(Date.now() + 6 * HOUR + 1_000);
    expect(row.digiflazzFailureDetail).toMatch(/unresolved/i);

    // Every money exit stays locked.
    expect(isDigiflazzInFlight(row)).toBe(true);
    expect(isDigiflazzCreditLocked(row)).toBe(true);
    const eligibility = computeOrderEligibility(row.status, null, { digiflazzInFlight: isDigiflazzInFlight(row), digiflazzCreditLocked: isDigiflazzCreditLocked(row) });
    expect(eligibility).toMatchObject({ canCredit: false, canFulfill: false });
    await expect(creditOrderToBalance(prisma, { orderId: order.id, adminId: 1 })).rejects.toMatchObject({ key: "error.order_in_flight_at_supplier" });
    await expect(fulfillManualOrder(prisma, order.id, { adminId: 1, content: "manual" })).rejects.toMatchObject({ key: "error.order_not_processing" });
    expect((await reloaded(order.id)).status).toBe(OrderStatus.PROCESSING);
    // It is not counted as waiting for a hand-fulfilment.
    expect(await countAwaitingManualFulfillment(prisma)).toBe(0);

    // Admins are alerted once, with unresolved (not failed) wording, and it is audited.
    const alerts = await reviewAlerts(order.id);
    expect(alerts).toHaveLength(1);
    const payload = JSON.parse(alerts[0]!.payloadJson) as { reason: string };
    expect(payload.reason).toMatch(/unresolved at Digiflazz/i);
    expect(payload.reason).toMatch(/reconcil/i);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_unresolved_at_supplier", targetId: order.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_dispatch_failed", targetId: order.id } })).toBe(0);
  });

  it("transient errors that outlast the 24h window also end up unresolved, not failed", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 25 * HOUR });
    digiflazzMock.createTransaction.mockRejectedValue(new Error("network blip"));

    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });
    const row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzFailureDetail).toContain("network blip");
    expect(await reviewAlerts(order.id)).toHaveLength(1);
  });

  it("a further Pending inside the 7-day window reschedules 6 hours out without a second alert", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 25 * HOUR });
    digiflazzMock.createTransaction.mockResolvedValue(pending(order.orderCode));
    await dispatchPendingDigiflazzOrders(prisma);

    await prisma.order.update({ where: { id: order.id }, data: { digiflazzNextRecheckAt: new Date(Date.now() - 1_000) } });
    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(2);
    const row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzAttempts).toBe(22);
    expect(row.digiflazzNextRecheckAt!.getTime()).toBeGreaterThan(Date.now() + 5 * HOUR);
    expect(await reviewAlerts(order.id)).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_unresolved_at_supplier", targetId: order.id } })).toBe(1);
  });

  it("the poller picks an unresolved order up only once its slow recheck is due", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 2 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED, nextRecheckAt: new Date(Date.now() + 3 * HOUR) });
    digiflazzMock.createTransaction.mockResolvedValue(pending(order.orderCode));

    expect(await dispatchPendingDigiflazzOrders(prisma)).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();

    await prisma.order.update({ where: { id: order.id }, data: { digiflazzNextRecheckAt: new Date(Date.now() - 1_000) } });
    expect(await dispatchPendingDigiflazzOrders(prisma)).toEqual({ claimed: 1, delivered: 0, pending: 1, failed: 0 });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("a late Sukses fulfils the unresolved order through the normal delivery path", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Sukses", sn: "SN-LATE", message: "ok", price: null });

    expect(await dispatchPendingDigiflazzOrders(prisma)).toEqual({ claimed: 1, delivered: 1, pending: 0, failed: 0 });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.DELIVERED);
    expect(row.digiflazzStatus).toBeNull();
    expect(row.digiflazzNextRecheckAt).toBeNull();
  });

  it("a late explicit Gagal fails the unresolved order through the normal terminal path", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Gagal", sn: null, message: "Nomor salah", price: null });

    expect(await dispatchPendingDigiflazzOrders(prisma)).toEqual({ claimed: 1, delivered: 0, pending: 0, failed: 1 });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(row.digiflazzStatus).toBe("failed");
    expect(row.digiflazzNextRecheckAt).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_dispatch_failed", targetId: order.id } })).toBe(1);
    expect(isDigiflazzInFlight(row)).toBe(false);
  });

  it("missing Digiflazz credentials on a recheck never fail an already-dispatched order", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED });
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);

    await dispatchPendingDigiflazzOrders(prisma);

    const row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzNextRecheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_dispatch_failed", targetId: order.id } })).toBe(0);
  });
});

describe("after the 7-day slow window", () => {
  it("stops calling the supplier, stays locked and re-alerts admins at most once a day", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 8 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED });

    const summary = await dispatchPendingDigiflazzOrders(prisma);

    expect(summary).toEqual({ claimed: 0, delivered: 0, pending: 0, failed: 0 });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
    let row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzNextRecheckAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    const alerts = await reviewAlerts(order.id);
    expect(alerts).toHaveLength(1);
    expect((JSON.parse(alerts[0]!.payloadJson) as { reason: string }).reason).toMatch(/still unresolved at Digiflazz/i);

    // Forced due again the same day: no second reminder.
    await prisma.order.update({ where: { id: order.id }, data: { digiflazzNextRecheckAt: new Date(Date.now() - 1_000) } });
    await dispatchPendingDigiflazzOrders(prisma);
    expect(await reviewAlerts(order.id)).toHaveLength(1);
    row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(isDigiflazzCreditLocked(row)).toBe(true);
  });
});

describe("markDigiflazzOrderFailedByAdmin (human override)", () => {
  it("moves an unresolved order to failed, audits the admin, and unlocks credit and manual fulfilment", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED, nextRecheckAt: new Date(Date.now() + 3 * HOUR) });

    await markDigiflazzOrderFailedByAdmin(prisma, order.id, { adminId: sample.user.id, note: "Digiflazz support confirmed ref was never processed" });

    const row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe("failed");
    expect(row.digiflazzNextRecheckAt).toBeNull();
    expect(row.digiflazzFailureDetail).toContain("Digiflazz support confirmed ref was never processed");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order.digiflazz_marked_failed_by_admin", targetId: order.id } });
    expect(audit.adminId).toBe(sample.user.id);
    expect(audit.details).toMatch(new RegExp(`^Marked order ${order.orderCode} as failed at Digiflazz`));
    expect(isDigiflazzInFlight(row)).toBe(false);
    await fulfillManualOrder(prisma, order.id, { adminId: sample.user.id, content: "delivered by hand" });
    expect((await reloaded(order.id)).status).toBe(OrderStatus.DELIVERED);
  });

  it("is refused for an order still inside its normal 24h checks", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: HOUR, status: "pending_at_supplier", nextRecheckAt: new Date(Date.now() + HOUR) });
    const err = await markDigiflazzOrderFailedByAdmin(prisma, order.id, { adminId: sample.user.id, note: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ key: "error.digiflazz_not_unresolved" });
    expect((await reloaded(order.id)).digiflazzStatus).toBe("pending_at_supplier");
  });

  it("is refused while a supplier check holds the in-flight lease", async () => {
    const order = await makeDispatchedOrder({
      dispatchedAgoMs: 3 * DAY,
      status: DIGIFLAZZ_STATUS_UNRESOLVED,
      nextRecheckAt: new Date(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS / 2),
    });
    await expect(markDigiflazzOrderFailedByAdmin(prisma, order.id, { adminId: sample.user.id, note: "x" })).rejects.toMatchObject({ key: "error.digiflazz_check_in_flight" });
    expect((await reloaded(order.id)).digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_marked_failed_by_admin" } })).toBe(0);
  });

  it("requires a note", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, status: DIGIFLAZZ_STATUS_UNRESOLVED, nextRecheckAt: new Date(Date.now() + 3 * HOUR) });
    await expect(markDigiflazzOrderFailedByAdmin(prisma, order.id, { adminId: sample.user.id, note: "   " })).rejects.toBeInstanceOf(ValidationError);
    expect((await reloaded(order.id)).digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
  });
});
