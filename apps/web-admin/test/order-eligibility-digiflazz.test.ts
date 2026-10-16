import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting, createOrderDirect, DIGIFLAZZ_USERNAME_KEY, DIGIFLAZZ_API_KEY_KEY } from "@app/db";
import { DeliveryType } from "@app/core/enums";
import { resetDb, buildSampleData } from "../../../tests/helpers/sampleData";
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";
import { buildApp } from "../src/server";

/**
 * The Orders list/detail must not offer "Fulfil manually" on a Digiflazz order
 * the provider is still working on — fulfillManualOrder refuses it anyway.
 */

const COOKIE = config.WEB_COOKIE_NAME;
const ADMIN_TG = 999;
let app: FastifyInstance;
let cookie: string;
let buyerId: number;
let csrf: string;
let adminId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb(prisma);
  const admin = await upsertUser(prisma, { telegramId: ADMIN_TG, username: "admin", fullName: "Admin" });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const session = makeSession(admin.id, ADMIN_TG, jti);
  cookie = session.raw;
  csrf = session.data.csrf;
  adminId = admin.id;
  await setSetting(prisma, "setup_completed", "true");
  buyerId = (await upsertUser(prisma, { telegramId: 4242, username: "buyer", fullName: "Buyer" })).id;
});

function makeOrder(extra: Record<string, unknown>) {
  return prisma.order.create({
    data: { orderCode: `ORD-${Math.random()}`, userId: buyerId, subtotalAmount: "1", totalAmount: "1", status: "PROCESSING", ...extra },
  });
}

describe("order eligibility for Digiflazz orders", () => {
  it("detail and list: canFulfill false while in flight, true once the provider failed it, true for MANUAL", async () => {
    const inFlight = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier" });
    const failed = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "failed" });
    const manual = await makeOrder({ fulfillmentProvider: "MANUAL" });

    const detail = async (id: number) =>
      (await app.inject({ method: "GET", url: `/api/orders/${id}`, cookies: { [COOKIE]: cookie } })).json() as { canFulfill: boolean; canCredit: boolean };
    // canCredit mirrors creditOrderToBalance's in-flight refusal.
    expect(await detail(inFlight.id)).toMatchObject({ canFulfill: false, canCredit: false });
    expect(await detail(failed.id)).toMatchObject({ canFulfill: true, canCredit: true });
    expect(await detail(manual.id)).toMatchObject({ canFulfill: true, canCredit: true });

    const list = await app.inject({ method: "GET", url: "/api/orders", cookies: { [COOKIE]: cookie } });
    const rows = list.json().orders as Array<{ id: number; eligibility: { canFulfill: boolean; canCredit: boolean } }>;
    const flags = (id: number) => rows.find((r) => r.id === id)!.eligibility;
    expect(flags(inFlight.id)).toMatchObject({ canFulfill: false, canCredit: false });
    expect(flags(failed.id)).toMatchObject({ canFulfill: true, canCredit: true });
    expect(flags(manual.id)).toMatchObject({ canFulfill: true, canCredit: true });
  });

  // Backend audit A5: an order unresolved at the supplier stays locked; the
  // only human way out is the audited "mark failed at Digiflazz" override.
  it("unresolved at the supplier: everything locked, only the mark-failed override offered, and it unlocks hand-fulfilment", async () => {
    const unresolved = await makeOrder({
      fulfillmentProvider: "DIGIFLAZZ",
      digiflazzStatus: "unresolved_at_supplier",
      digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000),
      digiflazzNextRecheckAt: new Date(Date.now() + 3 * 3_600_000),
    });
    const inFlight = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier", digiflazzDispatchedAt: new Date() });
    const detail = async (id: number) =>
      (await app.inject({ method: "GET", url: `/api/orders/${id}`, cookies: { [COOKIE]: cookie } })).json() as Record<string, unknown>;

    expect(await detail(unresolved.id)).toMatchObject({ canFulfill: false, canCredit: false, creditLockedBySupplier: true, canMarkSupplierFailed: true });
    expect(await detail(inFlight.id)).toMatchObject({ canMarkSupplierFailed: false });

    const markFailed = (id: number, note: string) =>
      app.inject({
        method: "POST",
        url: `/api/orders/${id}/digiflazz/mark-failed`,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        cookies: { [COOKIE]: cookie },
        payload: new URLSearchParams({ csrf_token: csrf, note }).toString(),
      });
    const noNote = await markFailed(unresolved.id, "  ");
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json()).toEqual({ error: "error.digiflazz_failure_note_required" });
    expect((await markFailed(inFlight.id, "checked")).statusCode).toBe(422);

    const res = await markFailed(unresolved.id, "Digiflazz support confirmed it never went through");
    expect(res.statusCode).toBe(200);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: unresolved.id } });
    expect(row.digiflazzStatus).toBe("failed");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order.digiflazz_marked_failed_by_admin", targetId: unresolved.id } });
    expect(audit.adminId).toBe(adminId);
    expect(await detail(unresolved.id)).toMatchObject({ canFulfill: true, canCredit: true, canMarkSupplierFailed: false });
  });

  it("refuses the mark-failed override for a readonly admin, changing nothing", async () => {
    const unresolved = await makeOrder({
      fulfillmentProvider: "DIGIFLAZZ",
      digiflazzStatus: "unresolved_at_supplier",
      digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000),
      digiflazzNextRecheckAt: new Date(Date.now() + 3 * 3_600_000),
    });
    await setSetting(prisma, webRoleKey(ADMIN_TG), "readonly");

    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${unresolved.id}/digiflazz/mark-failed`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookies: { [COOKIE]: cookie },
      payload: new URLSearchParams({ csrf_token: csrf, note: "checked with Digiflazz" }).toString(),
    });

    expect(res.statusCode).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unresolved.id } })).digiflazzStatus).toBe("unresolved_at_supplier");
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_marked_failed_by_admin" } })).toBe(0);
  });
});

// Audit A5 follow-up: the other two ways out (mark delivered, check now), the
// Reject guard, and the unresolved queue filter.
describe("unresolved at the supplier: mark delivered, check now, reject, list filter", () => {
  const post = (url: string, fields: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      cookies: { [COOKIE]: cookie },
      payload: new URLSearchParams({ csrf_token: csrf, ...fields }).toString(),
    });
  const detail = async (id: number) =>
    (await app.inject({ method: "GET", url: `/api/orders/${id}`, cookies: { [COOKIE]: cookie } })).json() as Record<string, unknown>;

  /** A real single-item Digiflazz order (fulfillDigiflazzOrder needs the item). */
  async function makeUnresolvedWithItem() {
    const sample = await buildSampleData(prisma);
    await prisma.denomination.update({
      where: { id: sample.product.id },
      data: {
        autoDeliverySource: "digiflazz",
        supplierSku: "ml100",
        deliveryType: DeliveryType.MANUAL_WITH_INFO,
        additionalFields: JSON.stringify([{ key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" }]),
      },
    });
    const order = (await createOrderDirect(prisma, { channel: "bot", user: sample.user, productId: sample.product.id, quantity: 1, customerData: JSON.stringify([{ user_id: "123456789" }]) }))!;
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "PROCESSING",
        paidAt: new Date(Date.now() - 3 * 24 * 3_600_000),
        digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000),
        digiflazzStatus: "unresolved_at_supplier",
        digiflazzNextRecheckAt: new Date(Date.now() + 3 * 3_600_000),
      },
    });
    return order;
  }

  it("offers all three ways out (and not Reject) only for an unresolved order", async () => {
    const unresolved = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "unresolved_at_supplier", digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000) });
    const inFlight = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier", digiflazzDispatchedAt: new Date() });
    const manual = await makeOrder({ fulfillmentProvider: "MANUAL" });

    expect(await detail(unresolved.id)).toMatchObject({ canMarkSupplierFailed: true, canMarkSupplierDelivered: true, canRecheckSupplier: true, canReject: false });
    expect(await detail(inFlight.id)).toMatchObject({ canMarkSupplierFailed: false, canMarkSupplierDelivered: false, canRecheckSupplier: false, canReject: false });
    expect(await detail(manual.id)).toMatchObject({ canMarkSupplierDelivered: false, canRecheckSupplier: false, canReject: true });
  });

  it("sends the next automatic check in the shop timezone for the unresolved banner, and null when none is scheduled", async () => {
    const next = new Date("2026-10-16T05:30:00.000Z");
    const scheduled = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "unresolved_at_supplier", digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000), digiflazzNextRecheckAt: next });
    const none = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "unresolved_at_supplier", digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000), digiflazzNextRecheckAt: null });

    const { displayDateTime } = await import("../src/dateDisplay");
    expect(((await detail(scheduled.id)).order as Record<string, unknown>).digiflazzNextRecheckAtDisplay).toBe(displayDateTime(next));
    expect(((await detail(none.id)).order as Record<string, unknown>).digiflazzNextRecheckAtDisplay).toBeNull();
  });

  it("Reject is refused server-side for an order unresolved at the supplier", async () => {
    const unresolved = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "unresolved_at_supplier", digiflazzDispatchedAt: new Date(Date.now() - 3 * 24 * 3_600_000) });
    const res = await post(`/api/orders/${unresolved.id}/reject`, { reason: "buyer asked" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "error.order_in_flight_at_supplier" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: unresolved.id } })).status).toBe("PROCESSING");
  });

  it("mark-delivered: note required, refused outside the unresolved state, delivers and audits the session admin, then refuses a repeat", async () => {
    const order = await makeUnresolvedWithItem();
    const inFlight = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier", digiflazzDispatchedAt: new Date() });

    const noNote = await post(`/api/orders/${order.id}/digiflazz/mark-delivered`, { note: " " });
    expect(noNote.statusCode).toBe(400);
    expect(noNote.json()).toEqual({ error: "error.digiflazz_delivery_note_required" });
    expect((await post(`/api/orders/${inFlight.id}/digiflazz/mark-delivered`, { note: "checked" })).statusCode).toBe(422);

    const res = await post(`/api/orders/${order.id}/digiflazz/mark-delivered`, { note: "Digiflazz CS confirmed it went through", sn: "SN-777" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DELIVERED");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "order.digiflazz_marked_delivered_by_admin", targetId: order.id } });
    expect(audit.adminId).toBe(adminId);
    expect(await detail(order.id)).toMatchObject({ canMarkSupplierDelivered: false, canRecheckSupplier: false });

    const again = await post(`/api/orders/${order.id}/digiflazz/mark-delivered`, { note: "again" });
    expect(again.statusCode).toBe(422);
    expect(again.json()).toMatchObject({ error: "error.digiflazz_not_unresolved" });
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id, status: "DELIVERED" } })).toBe(1);
  });

  it("recheck: refused outside the unresolved state, busy while a check holds the lease", async () => {
    const inFlight = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier", digiflazzDispatchedAt: new Date() });
    expect((await post(`/api/orders/${inFlight.id}/digiflazz/recheck`)).json()).toMatchObject({ error: "error.digiflazz_not_unresolved" });

    const order = await makeUnresolvedWithItem();
    await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, "shopuser");
    await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, "shopkey");
    await prisma.order.update({ where: { id: order.id }, data: { digiflazzNextRecheckAt: new Date(Date.now() + 20_000) } });
    const res = await post(`/api/orders/${order.id}/digiflazz/recheck`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, outcome: "busy" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).digiflazzStatus).toBe("unresolved_at_supplier");
  });

  it("readonly admins cannot mark delivered or recheck", async () => {
    const order = await makeUnresolvedWithItem();
    await setSetting(prisma, webRoleKey(ADMIN_TG), "readonly");
    expect((await post(`/api/orders/${order.id}/digiflazz/mark-delivered`, { note: "checked with Digiflazz" })).statusCode).toBe(403);
    expect((await post(`/api/orders/${order.id}/digiflazz/recheck`)).statusCode).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PROCESSING");
    expect(await prisma.auditLog.count({ where: { action: { in: ["order.digiflazz_marked_delivered_by_admin", "order.digiflazz_rechecked_by_admin"] } } })).toBe(0);
  });

  it("the list's digiflazz=unresolved filter returns only unresolved PROCESSING orders, with digiflazzStatus in each row", async () => {
    const unresolved = await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "unresolved_at_supplier" });
    await makeOrder({ fulfillmentProvider: "DIGIFLAZZ", digiflazzStatus: "pending_at_supplier" });
    await makeOrder({ fulfillmentProvider: "MANUAL" });

    const res = await app.inject({ method: "GET", url: "/api/orders?status=PROCESSING&digiflazz=unresolved", cookies: { [COOKIE]: cookie } });
    const body = res.json() as { orders: Array<{ id: number; digiflazzStatus: string | null }>; total: number };
    expect(body.total).toBe(1);
    expect(body.orders.map((o) => o.id)).toEqual([unresolved.id]);
    expect(body.orders[0]!.digiflazzStatus).toBe("unresolved_at_supplier");
  });
});
