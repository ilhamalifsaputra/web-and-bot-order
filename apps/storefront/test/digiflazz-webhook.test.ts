// Digiflazz webhook (POST /pay/digiflazz/callback) — Task 3 (original pilot
// plan), hardened by Task 12 (backend audit 2026-08-21, I-1/I-4): the
// callback's signature (verifyCallback, @app/core/suppliers/digiflazz) only
// authenticates that SOME signed request named this refId — it does NOT bind
// `status`, so it is no longer trusted to decide what happens. Every callback
// that names a single-item Digiflazz order triggers a fresh
// createTransaction(refId) call (idempotent by refId per this client's own
// doc comment) and the handler acts on THAT live result, never on cb.status.
// Idempotency against a duplicate/replayed live-Sukses report still comes
// from fulfillDigiflazzOrder's own atomic PROCESSING -> DELIVERED claim
// (packages/db/src/crud/digiflazz.ts). Pattern:
// apps/storefront/test/tokopay-webhook.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
// Wraps (not replaces) the real alertDigiflazzDispatchFailed so a single test
// below can force it to throw (mockImplementationOnce) — verifying the Gagal
// branch's try/catch still 200s — while every other test keeps the real
// enqueue-alert + audit-log behavior.
vi.mock("@app/db", async (orig) => {
  const actual = await orig<typeof import("@app/db")>();
  return {
    ...actual,
    alertDigiflazzDispatchFailed: vi.fn(actual.alertDigiflazzDispatchFailed),
  };
});
// Task 12: the webhook now calls createTransaction as a live re-verification
// step — mock it (this file never makes a real HTTP call), same
// vi.hoisted + importOriginal pattern packages/db/src/crud/digiflazz.test.ts
// already uses, so verifyCallback/parseProductRegion/etc. stay real and only
// createTransaction is stubbed.
const digiflazzSupplierMock = vi.hoisted(() => ({
  createTransaction: vi.fn(),
}));
vi.mock("@app/core/suppliers/digiflazz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/core/suppliers/digiflazz")>()),
  createTransaction: digiflazzSupplierMock.createTransaction,
}));

import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  alertDigiflazzDispatchFailed,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  ADMIN_IDS_KEY,
} from "@app/db";
import { buildApp } from "../src/server";

const USERNAME = "shop-test-digiflazz";
const API_KEY = "key-test-digiflazz";

async function enableDigiflazz() {
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, USERNAME);
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, API_KEY);
}
async function disableDigiflazz() {
  await deleteSetting(prisma, DIGIFLAZZ_USERNAME_KEY);
  await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
}

/** Build a callback payload + a REAL signature
 * (md5(refId + ":" + secretKey), per packages/core/src/suppliers/digiflazz.ts
 * verifyCallback — the secret is the same Digiflazz apiKey Settings holds,
 * there being no separate webhook-secret field yet). */
function signedPayload(args: { refId: string; status?: string; sn?: string; message?: string }) {
  const signature = createHash("md5").update(`${args.refId}:${API_KEY}`).digest("hex");
  return {
    ref_id: args.refId,
    status: args.status ?? "Sukses",
    sn: args.sn,
    message: args.message,
    signature,
  };
}

let app: FastifyInstance;
let userId: number;
let denomId: number;
let plainDenomId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "DigiflazzCat", slug: "digiflazz-cat", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Digiflazz Webhook Test Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Digiflazz Webhook Test Product",
    type: "SHARED",
    durationLabel: "1x",
    price: "15000",
    autoDeliverySource: "digiflazz",
    supplierSku: "ml100",
    deliveryType: "manual_with_info",
    additionalFields: JSON.stringify([
      { key: "user_id", label: { id: "Game ID", en: "Game ID" }, type: "text", required: true, options: [], placeholder: "" },
    ]),
  });
  denomId = denom.id;

  // Task 12 (I-4): a plain, NOT Digiflazz-routed denomination (no
  // autoDeliverySource) — for the "callback names an order that isn't
  // Digiflazz-routed" test below.
  const plainProduct = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Manual Webhook Test Product" });
  const plainDenom = await createDenomination(prisma, {
    productId: plainProduct.id,
    name: "Manual Webhook Test Product",
    type: "SHARED",
    durationLabel: "1x",
    price: "5000",
    deliveryType: "manual",
  });
  plainDenomId = plainDenom.id;

  // Real telegramId (not null, unlike the guest-buyer pattern the other
  // callback tests use) — fulfillDigiflazzOrder's buyer receipt DM
  // (enqueueManualDeliveredDm, packages/db/src/crud/notifications.ts) is a
  // no-op for a null telegramId, and this file wants to actually exercise
  // that outbox enqueue.
  const user = await prisma.user.create({
    data: { telegramId: 424242, referralCode: "DFWH01" },
  });
  userId = user.id;

  await setSetting(prisma, "setup_completed", "true");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

beforeEach(async () => {
  await enableDigiflazz();
  digiflazzSupplierMock.createTransaction.mockReset();
});

/** Create a PROCESSING order directly (bypassing checkout/cart/the dispatch
 * poller) for webhook-only tests — the state a Digiflazz webhook always
 * lands on. */
async function createProcessingDigiflazzOrder(orderCode: string, totalAmount = "15000") {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: totalAmount,
      totalAmount,
      status: "PROCESSING",
      currency: "IDR",
      paymentMethod: "TOKOPAY",
      customerData: JSON.stringify([{ user_id: "123456789" }]),
      items: {
        create: [{ productId: denomId, quantity: 1, unitPrice: totalAmount, warrantyDaysSnapshot: 0 }],
      },
    },
  });
}

/** Same shape, but routed to the plain (non-Digiflazz) denomination — for
 * the "callback names an order that isn't Digiflazz-routed" test. */
async function createProcessingPlainOrder(orderCode: string, totalAmount = "5000") {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: totalAmount,
      totalAmount,
      status: "PROCESSING",
      currency: "IDR",
      paymentMethod: "TOKOPAY",
      items: {
        create: [{ productId: plainDenomId, quantity: 1, unitPrice: totalAmount, warrantyDaysSnapshot: 0 }],
      },
    },
  });
}

describe("POST /pay/digiflazz/callback", () => {
  it("403s when Digiflazz is disabled (no creds configured)", async () => {
    await disableDigiflazz();
    const payload = signedPayload({ refId: "ORD-DISABLED" });
    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
  });

  it("403s on a bad signature", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pay/digiflazz/callback",
      payload: { ref_id: "ORD-BADSIG", status: "Sukses", sn: "SN-1", signature: "0000000000000000000000000000000" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
  });

  it("returns unmatched when no order matches the ref_id", async () => {
    const payload = signedPayload({ refId: "ORD-NO-SUCH-ORDER" });
    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
  });

  // Task 12 (I-1) regression guard: the callback's OWN status/sn must no
  // longer be trusted — the handler re-verifies live via createTransaction
  // before acting. Here the callback says Sukses/SN-STALE, but the mocked
  // live re-check reports the real (matching) Sukses/SN-12345 — the order
  // still delivers, using the FRESH sn, not cb.sn.
  it("happy path: a Sukses callback whose live re-check also reports Sukses delivers the order and enqueues the buyer's receipt DM", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFHAPPY");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Sukses",
      sn: "SN-12345",
      message: "ok",
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-STALE" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(updated!.deliveredContent).toBe("SN-12345"); // the live re-check's sn, not cb.sn

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_MANUAL_DELIVERED_DM" },
    });
    expect(dmRows.length).toBeGreaterThan(0);

    expect(digiflazzSupplierMock.createTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ refId: order.orderCode, buyerSkuCode: "ml100", customerNo: "123456789" }),
    );
  });

  it("is idempotent: a replayed/duplicate Sukses callback for an already-delivered order still 200s without re-delivering or re-checking live", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFREPLAY");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Sukses",
      sn: "SN-1",
      message: "ok",
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    const first = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(first.json()).toEqual({ status: "ok" });

    // The order is DELIVERED after the first call, so the second replay is
    // now refused by the order.status !== PROCESSING guard before it ever
    // reaches the live re-check (review fix, post-Task-12) — a strictly
    // better outcome than the previous "call createTransaction again, then
    // rely on fulfillDigiflazzOrder's atomic claim to catch the race".
    const second = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "unmatched" });
    expect(digiflazzSupplierMock.createTransaction).toHaveBeenCalledTimes(1); // not called again on replay

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(updated!.deliveredContent).toBe("SN-1"); // unchanged by the replay
  });

  // Task 12 (I-1) core proof: a captured/replayed Sukses callback whose live
  // re-check no longer confirms Sukses (simulating a callback that's stale,
  // forged, or replayed after Digiflazz's real status moved on) must NOT
  // deliver — this is the actual vulnerability the task fixes.
  it("a Sukses callback whose live re-check returns Pending does not deliver the order (stale/replayed callback guard)", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFSTALE");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Pending",
      sn: null,
      message: null,
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-FORGED" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
    expect(updated!.deliveredContent).toBeNull();
    expect(digiflazzSupplierMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  // Review fix (Minor #6): unlike the other Gagal/Pending tests above (which
  // mock the live re-check to MATCH the callback's own status, so they'd
  // still pass even if the handler regressed to trusting cb.status
  // directly), this one deliberately MISMATCHES them — callback says Sukses,
  // live re-check says Gagal — so it actually catches a regression back to
  // reading cb.status instead of result.status.
  it("takes the Gagal path (not Sukses) when the callback claims Sukses but the live re-check disagrees", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await createProcessingDigiflazzOrder("ORD-DFMISMATCH");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Gagal",
      sn: null,
      message: "Saldo tidak cukup",
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-FORGED" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING"); // NOT delivered
    expect(updated!.deliveredContent).toBeNull();

    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull(); // Gagal path was taken, same alert as the other Gagal tests
  });

  it("a Gagal callback enqueues an admin alert and leaves the order PROCESSING", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await createProcessingDigiflazzOrder("ORD-DFGAGAL");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Gagal",
      sn: null,
      message: "Saldo tidak cukup",
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Gagal", message: "Saldo tidak cukup" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");

    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "order.digiflazz_dispatch_failed", targetId: order.id },
    });
    expect(auditRow).not.toBeNull();
  });

  it("a Gagal callback whose admin alert throws still 200s instead of 500ing", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await createProcessingDigiflazzOrder("ORD-DFGAGALTHROWS");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Gagal",
      sn: null,
      message: "Saldo tidak cukup",
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Gagal", message: "Saldo tidak cukup" });

    vi.mocked(alertDigiflazzDispatchFailed).mockImplementationOnce(() => {
      throw new Error("transient DB write failure");
    });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  it("a Pending callback takes no action and leaves the order PROCESSING", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFPENDING");
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Pending",
      sn: null,
      message: null,
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Pending" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  // Review fix (Important, post-Task-12): a validly-signed replay for an
  // order that has already left PROCESSING (delivered, cancelled, refunded,
  // ...) must never reach the live re-check — otherwise every replay of a
  // valid signature turns into real supplier traffic (a live POST
  // /transaction to Digiflazz), relying solely on Digiflazz's own unverified
  // refId-dedup assumption to avoid a second real top-up. The guard runs
  // BEFORE resolveSingleDigiflazzItem/createTransaction, so it also covers
  // this order being a genuine single-item Digiflazz order.
  it("returns unmatched for a validly-signed Sukses callback naming an order that is already DELIVERED, without calling the live re-check", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFDELIVERED");
    await prisma.order.update({
      where: { id: order.id },
      data: { status: "DELIVERED", deliveredContent: "SN-ALREADY", deliveredAt: new Date() },
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-REPLAY" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(updated!.deliveredContent).toBe("SN-ALREADY"); // unchanged by the replay
  });

  // Task 12 (I-4): a validly-signed callback naming an order that isn't
  // actually Digiflazz-routed (e.g. a plain manual order) must be refused
  // before any live re-check is attempted — resolveSingleDigiflazzItem's
  // guard, not a bare "order found" check.
  it("returns unmatched for a validly-signed callback naming an order that isn't Digiflazz-routed, without calling the live re-check", async () => {
    const order = await createProcessingPlainOrder("ORD-DFNOTDIGI");
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  // Task 12 (I-1): the live re-check itself can fail (network error, timeout,
  // malformed response — same failure modes dispatchPendingDigiflazzOrders's
  // own try/catch already handles). Must not take any delivery action and
  // must still 200 (so Digiflazz doesn't retry-storm the endpoint) — leaving
  // the order PROCESSING for a future callback or the next poller tick.
  it("leaves the order PROCESSING and still 200s when the live re-check itself throws", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFLIVEFAIL");
    digiflazzSupplierMock.createTransaction.mockRejectedValue(new Error("Digiflazz transaction failed: request timed out"));
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
    expect(updated!.deliveredContent).toBeNull();
  });
});
