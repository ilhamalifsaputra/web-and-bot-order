import "./setup-env"; // MUST be first: sets env + builds the temp DB schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, upsertUser, setSetting } from "@app/db";
import { resetDb } from "../../../tests/helpers/sampleData";
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
