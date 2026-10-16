/**
 * Audit A5 follow-up: the admin ways out of "unresolved_at_supplier" besides
 * "mark failed" — "mark delivered" (the admin confirmed with Digiflazz that the
 * top-up went through), "check supplier now" (one live status check that never
 * spends the backoff budget), the queue counter, and the Reject guard.
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
  DIGIFLAZZ_OVERRIDE_LEASE_MARGIN_MS,
  DIGIFLAZZ_ADMIN_SN_MAX_LENGTH,
  fulfillDigiflazzOrder,
  markDigiflazzOrderDeliveredByAdmin,
  markDigiflazzOrderFailedByAdmin,
  recheckDigiflazzOrderNow,
  countDigiflazzUnresolved,
  countAwaitingManualFulfillment,
  rejectOrder,
  computeOrderEligibility,
  isDigiflazzInFlight,
  listOrders,
  countOrders,
} from "@app/db";
import { DIGIFLAZZ_STATUS_UNRESOLVED } from "@app/core/orderFulfillment";
import { OrderStatus, DeliveryType } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { decryptDeliveredContent } from "@app/core/credentialCrypto";

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

/** A paid Digiflazz order handed to the supplier `dispatchedAgoMs` ago. */
async function makeDispatchedOrder(opts: { dispatchedAgoMs: number; status?: string; attempts?: number; nextRecheckAt?: Date | null }) {
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
      digiflazzAttempts: opts.attempts ?? 25,
      digiflazzStatus: opts.status ?? DIGIFLAZZ_STATUS_UNRESOLVED,
      digiflazzNextRecheckAt: opts.nextRecheckAt === undefined ? new Date(Date.now() + 3 * HOUR) : opts.nextRecheckAt,
      digiflazzFailureDetail: "Unresolved at Digiflazz: still reporting Pending more than 24 hours after dispatch.",
    },
  });
  return order;
}

const reloaded = (id: number) => prisma.order.findUniqueOrThrow({ where: { id } });
const deliveredHistory = (orderId: number) => prisma.orderStatusHistory.count({ where: { orderId, status: OrderStatus.DELIVERED } });
const completedEmails = (orderId: number) => prisma.notificationOutbox.count({ where: { orderId, event: "order.completed.customer" } });
const sukses = (refId: string, sn = "SN-SUPPLIER") => ({ refId, status: "Sukses", sn, message: "ok", price: null });

describe("markDigiflazzOrderDeliveredByAdmin", () => {
  it("delivers an unresolved order through the normal delivery path, audited, with no refund or credit", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    const balanceBefore = (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance;

    await markDigiflazzOrderDeliveredByAdmin(prisma, {
      orderId: order.id,
      adminId: sample.user.id,
      note: "Digiflazz CS confirmed trx sukses via WhatsApp",
      sn: "SN-FROM-DIGIFLAZZ-123",
    });

    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.DELIVERED);
    expect(row.deliveredAt).not.toBeNull();
    expect(row.digiflazzStatus).toBeNull();
    expect(row.digiflazzNextRecheckAt).toBeNull();
    expect(row.digiflazzFailureDetail).toBeNull();
    // The buyer sees the supplier's serial number, never the admin's private note.
    expect(decryptDeliveredContent(row.deliveredContent, order.id)).toBe("SN-FROM-DIGIFLAZZ-123");
    expect(await prisma.orderItem.count({ where: { orderId: order.id, status: "DELIVERED" } })).toBe(1);
    expect(await deliveredHistory(order.id)).toBe(1);
    expect(await prisma.fulfillmentMessage.count({ where: { orderId: order.id } })).toBe(1);
    expect(await completedEmails(order.id)).toBe(1);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order.digiflazz_marked_delivered_by_admin", targetId: order.id } });
    expect(audit.adminId).toBe(sample.user.id);
    expect(audit.details).toMatch(new RegExp(`^Marked order ${order.orderCode} as delivered`));
    expect(audit.details).toContain("Digiflazz CS confirmed trx sukses via WhatsApp");
    expect(await prisma.auditLog.count({ where: { action: "order.auto_fulfill_digiflazz", targetId: order.id } })).toBe(0);

    // No money moved back to the buyer.
    expect(await prisma.walletTransaction.count({ where: { orderId: order.id } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance.toString()).toBe(balanceBefore.toString());
  });

  it("without a serial number delivers with empty content (the admin note stays private)", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "private reconciliation note" });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.DELIVERED);
    expect(decryptDeliveredContent(row.deliveredContent, order.id) ?? "").toBe("");
  });

  it("is idempotent: a second call is refused and writes nothing more", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "confirmed" });
    const outboxBefore = await prisma.notificationOutbox.count({ where: { orderId: order.id } });

    await expect(
      markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "again" }),
    ).rejects.toMatchObject({ key: "error.digiflazz_not_unresolved" });

    expect(await deliveredHistory(order.id)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_marked_delivered_by_admin", targetId: order.id } })).toBe(1);
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id } })).toBe(outboxBefore);
  });

  it("requires a note", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    const err = await markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "  " }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toMatchObject({ key: "error.digiflazz_delivery_note_required" });
    expect((await reloaded(order.id)).status).toBe(OrderStatus.PROCESSING);
  });

  it("is refused for an order still inside its normal 24h checks", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: HOUR, status: "pending_at_supplier", nextRecheckAt: new Date(Date.now() + HOUR) });
    await expect(
      markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "x" }),
    ).rejects.toMatchObject({ key: "error.digiflazz_not_unresolved" });
    expect((await reloaded(order.id)).status).toBe(OrderStatus.PROCESSING);
  });

  it("is refused while a supplier check holds the in-flight lease", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, nextRecheckAt: new Date(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS / 2) });
    await expect(
      markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "x" }),
    ).rejects.toMatchObject({ key: "error.digiflazz_check_in_flight" });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(await deliveredHistory(order.id)).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_marked_delivered_by_admin" } })).toBe(0);
  });

  // Review M1: the lease check reads the clock right before the claim, so a
  // poller that took the lease after the override started (its `now`) is not
  // overridden; a lease ending just past the override's own window is too.
  it.each([
    ["a lease taken after the override started", 0],
    ["a lease ending within the safety margin", DIGIFLAZZ_OVERRIDE_LEASE_MARGIN_MS / 2],
  ])("both overrides respect %s", async (_name, extraMs) => {
    const startedAt = new Date(Date.now() - 10_000);
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, nextRecheckAt: new Date(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS + extraMs) });
    await expect(
      markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "x" }, startedAt),
    ).rejects.toMatchObject({ key: "error.digiflazz_check_in_flight" });
    await expect(
      markDigiflazzOrderFailedByAdmin(prisma, order.id, { adminId: sample.user.id, note: "x" }, startedAt),
    ).rejects.toMatchObject({ key: "error.digiflazz_check_in_flight" });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(await prisma.auditLog.count({ where: { action: { in: ["order.digiflazz_marked_delivered_by_admin", "order.digiflazz_marked_failed_by_admin"] } } })).toBe(0);
  });

  it("still overrides a scheduled recheck beyond the lease and its margin", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, nextRecheckAt: new Date(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS + DIGIFLAZZ_OVERRIDE_LEASE_MARGIN_MS + 30_000) });
    await markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "confirmed" });
    expect((await reloaded(order.id)).status).toBe(OrderStatus.DELIVERED);
  });

  // Review M3: every caller is bounded, not only the admin route.
  it("trims and caps the serial number at 200 characters", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    const long = "S".repeat(250);
    await markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "confirmed", sn: `  ${long}  ` });
    expect(DIGIFLAZZ_ADMIN_SN_MAX_LENGTH).toBe(200);
    expect(decryptDeliveredContent((await reloaded(order.id)).deliveredContent, order.id)).toBe("S".repeat(200));
  });

  it("override first, late supplier Sukses second: the supplier's delivery is refused, nothing is duplicated", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "confirmed", sn: "SN-ADMIN" });

    await expect(fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-LATE" })).rejects.toMatchObject({ key: "error.order_not_processing" });

    expect(await deliveredHistory(order.id)).toBe(1);
    expect(await completedEmails(order.id)).toBe(1);
    expect(decryptDeliveredContent((await reloaded(order.id)).deliveredContent, order.id)).toBe("SN-ADMIN");
  });

  it("supplier Sukses first, override second: the override is refused and not audited", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-SUPPLIER" });

    await expect(
      markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "confirmed" }),
    ).rejects.toMatchObject({ key: "error.digiflazz_not_unresolved" });

    expect(await deliveredHistory(order.id)).toBe(1);
    expect(await completedEmails(order.id)).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_marked_delivered_by_admin" } })).toBe(0);
  });

  it("override racing a concurrent supplier Sukses: exactly one wins, no duplicate delivery or notification", async () => {
    for (let round = 0; round < 5; round++) {
      await resetDb(prisma);
      sample = await buildSampleData(prisma);
      const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });

      const results = await Promise.allSettled([
        fulfillDigiflazzOrder(prisma, order.id, { sn: "SN-SUPPLIER" }),
        markDigiflazzOrderDeliveredByAdmin(prisma, { orderId: order.id, adminId: sample.user.id, note: "confirmed", sn: "SN-ADMIN" }),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await reloaded(order.id)).status).toBe(OrderStatus.DELIVERED);
      expect(await deliveredHistory(order.id)).toBe(1);
      expect(await completedEmails(order.id)).toBe(1);
      expect(await prisma.fulfillmentMessage.count({ where: { orderId: order.id } })).toBe(1);
      const adminWon = results[1]!.status === "fulfilled";
      expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_marked_delivered_by_admin" } })).toBe(adminWon ? 1 : 0);
      expect(await prisma.auditLog.count({ where: { action: "order.auto_fulfill_digiflazz" } })).toBe(adminWon ? 0 : 1);
    }
  });
});

describe("recheckDigiflazzOrderNow", () => {
  it("Sukses delivers the order through the normal path", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    digiflazzMock.createTransaction.mockResolvedValue(sukses(order.orderCode, "SN-NOW"));

    const res = await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id });

    expect(res).toEqual({ orderCode: order.orderCode, outcome: "delivered" });
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
    expect(digiflazzMock.createTransaction.mock.calls[0]![1]).toMatchObject({ refId: order.orderCode, buyerSkuCode: "ml100", customerNo: "123456789" });
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.DELIVERED);
    expect(decryptDeliveredContent(row.deliveredContent, order.id)).toBe("SN-NOW");
    expect(await deliveredHistory(order.id)).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order.digiflazz_rechecked_by_admin", targetId: order.id } });
    expect(audit.adminId).toBe(sample.user.id);
    expect(audit.details).toMatch(/delivered/i);
  });

  it("Pending keeps the order unresolved without spending the backoff budget or moving its schedule", async () => {
    const scheduled = new Date(Date.now() + 3 * HOUR);
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, attempts: 25, nextRecheckAt: scheduled });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Pending", sn: null, message: null, price: null });

    const res = await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id });

    expect(res.outcome).toBe("still_pending");
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzAttempts).toBe(25);
    expect(row.digiflazzNextRecheckAt!.getTime()).toBe(scheduled.getTime());
    // The unresolved explanation the admin reads is kept.
    expect(row.digiflazzFailureDetail).toMatch(/Unresolved at Digiflazz/);
  });

  it("a transient error keeps the order unresolved and restores its schedule", async () => {
    const scheduled = new Date(Date.now() + 3 * HOUR);
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, nextRecheckAt: scheduled });
    digiflazzMock.createTransaction.mockRejectedValue(new Error("network blip"));

    const res = await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id });

    expect(res.outcome).toBe("still_pending");
    const row = await reloaded(order.id);
    expect(row.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(row.digiflazzNextRecheckAt!.getTime()).toBe(scheduled.getTime());
    expect(row.digiflazzAttempts).toBe(25);
  });

  it("an order past its 7-day window is checked but never failed by the window", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 8 * DAY });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Pending", sn: null, message: null, price: null });

    expect((await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id })).outcome).toBe("still_pending");
    expect((await reloaded(order.id)).digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
  });

  it("an explicit Gagal fails the order through the normal terminal path", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Gagal", sn: null, message: "Nomor salah", price: null });

    const res = await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id });

    expect(res.outcome).toBe("failed");
    const row = await reloaded(order.id);
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(row.digiflazzStatus).toBe("failed");
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_dispatch_failed", targetId: order.id } })).toBe(1);
  });

  it("returns busy without calling the supplier while another check holds the lease", async () => {
    const lease = new Date(Date.now() + DIGIFLAZZ_RECHECK_CLAIM_LEASE_MS / 2);
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, nextRecheckAt: lease });

    const res = await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id });

    expect(res.outcome).toBe("busy");
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
    expect((await reloaded(order.id)).digiflazzNextRecheckAt!.getTime()).toBe(lease.getTime());
  });

  it("allows one check per order per minute", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Pending", sn: null, message: null, price: null });

    expect((await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id })).outcome).toBe("still_pending");
    expect((await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id })).outcome).toBe("busy");
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);

    // A minute later it may check again.
    await prisma.auditLog.updateMany({
      where: { action: "order.digiflazz_rechecked_by_admin", targetId: order.id },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    expect((await recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id })).outcome).toBe("still_pending");
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(2);
  });

  it("two concurrent checks call the supplier once", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    digiflazzMock.createTransaction.mockResolvedValue({ refId: order.orderCode, status: "Pending", sn: null, message: null, price: null });

    const outcomes = await Promise.all([
      recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id }),
      recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id }),
    ]);

    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["busy", "still_pending"]);
    expect(digiflazzMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("is refused for an order that is not unresolved", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: HOUR, status: "pending_at_supplier", nextRecheckAt: new Date(Date.now() + HOUR) });
    await expect(recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id })).rejects.toMatchObject({ key: "error.digiflazz_not_unresolved" });
    expect(digiflazzMock.createTransaction).not.toHaveBeenCalled();
  });

  it("is refused when Digiflazz is not configured, leaving the order untouched", async () => {
    const scheduled = new Date(Date.now() + 3 * HOUR);
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, nextRecheckAt: scheduled });
    await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
    await expect(recheckDigiflazzOrderNow(prisma, { orderId: order.id, adminId: sample.user.id })).rejects.toMatchObject({ key: "error.digiflazz_not_configured" });
    expect((await reloaded(order.id)).digiflazzNextRecheckAt!.getTime()).toBe(scheduled.getTime());
  });
});

describe("unresolved queue and Reject guard", () => {
  it("countDigiflazzUnresolved counts only PROCESSING orders unresolved at the supplier; they stay out of the manual queue", async () => {
    await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await makeDispatchedOrder({ dispatchedAgoMs: HOUR, status: "pending_at_supplier" });
    const failed = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY, status: "failed", nextRecheckAt: null });

    expect(await countDigiflazzUnresolved(prisma)).toBe(1);
    expect(await countAwaitingManualFulfillment(prisma)).toBe(1); // only the failed one
    void failed;
  });

  it("the digiflazz=unresolved list filter selects PROCESSING orders with that sub-status", async () => {
    const unresolved = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await makeDispatchedOrder({ dispatchedAgoMs: HOUR, status: "pending_at_supplier" });

    const rows = await listOrders(prisma, { digiflazz: "unresolved" });
    expect(rows.map((r) => r.id)).toEqual([unresolved.id]);
    expect(rows[0]!.digiflazzStatus).toBe(DIGIFLAZZ_STATUS_UNRESOLVED);
    expect(await countOrders(prisma, { digiflazz: "unresolved" })).toBe(1);
  });

  it("rejectOrder refuses an order still in flight at the supplier, even an unpaid one, and canReject is false", async () => {
    const order = await makeDispatchedOrder({ dispatchedAgoMs: 3 * DAY });
    await prisma.order.update({ where: { id: order.id }, data: { paidAt: null, paymentState: null } });

    await expect(rejectOrder(prisma, order.id, { adminId: sample.user.id, reason: "x" })).rejects.toMatchObject({ key: "error.order_in_flight_at_supplier" });
    expect((await reloaded(order.id)).status).toBe(OrderStatus.PROCESSING);

    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: { select: { deliveryTypeSnapshot: true, product: { select: { autoDeliverySource: true, deliveryType: true } } } } },
    });
    expect(computeOrderEligibility(row.status, null, { digiflazzInFlight: isDigiflazzInFlight(row) }).canReject).toBe(false);
  });
});
