// Digiflazz webhook (POST /pay/digiflazz/callback) — Task 3 (original pilot
// plan), hardened by Task 12 (backend audit 2026-08-21, I-1/I-4). The
// signature (verifyWebhook, @app/core/suppliers/digiflazz: Digiflazz's real
// X-Hub-Signature HMAC-SHA1 over the raw body) authenticates the delivery,
// but a signed delivery can still be replayed, so its own `status` is never
// trusted to decide what happens. Every callback
// that names a single-item Digiflazz order triggers a fresh
// createTransaction(refId) call (idempotent by refId per this client's own
// doc comment) and the handler acts on THAT live result, never on cb.status.
// Idempotency against a duplicate/replayed live-Sukses report still comes
// from fulfillDigiflazzOrder's own atomic PROCESSING -> DELIVERED claim
// (packages/db/src/crud/digiflazz.ts). Pattern:
// apps/storefront/test/tokopay-webhook.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));
// Wraps (not replaces) the real recordDigiflazzOutcome so a single test below
// can force it to throw (mockImplementationOnce) — verifying the Gagal
// branch's try/catch still 200s — while every other test keeps the real
// shared decision logic (attempt/backoff writes, alert-enqueue + audit-log
// on a terminal outcome) that the poller (dispatchPendingDigiflazzOrders)
// also goes through.
vi.mock("@app/db", async (orig) => {
  const actual = await orig<typeof import("@app/db")>();
  return {
    ...actual,
    recordDigiflazzOutcome: vi.fn(actual.recordDigiflazzOutcome),
  };
});
// Task 12: the webhook now calls createTransaction as a live re-verification
// step — mock it (this file never makes a real HTTP call), same
// vi.hoisted + importOriginal pattern packages/db/src/crud/digiflazz.test.ts
// already uses, so verifyWebhook/parseProductRegion/etc. stay real and only
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
import { decryptDeliveredContent, encryptDeliveredContent } from "@app/core/credentialCrypto";
import { logger } from "@app/core/logger";
import { DigiflazzRequestError } from "@app/core/suppliers/digiflazz";
import {
  prisma,
  initDb,
  setSetting,
  deleteSetting,
  createCatalogProduct,
  createDenomination,
  recordDigiflazzOutcome,
  DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS,
  dispatchPendingDigiflazzOrders,
  dispatchDigiflazzOrderNow,
  DIGIFLAZZ_USERNAME_KEY,
  DIGIFLAZZ_API_KEY_KEY,
  DIGIFLAZZ_WEBHOOK_SECRET_KEY,
  setEncryptedSetting,
  ADMIN_IDS_KEY,
} from "@app/db";
import { buildApp } from "../src/server";

const USERNAME = "shop-test-digiflazz";
const API_KEY = "key-test-digiflazz";
const WEBHOOK_SECRET = "whsec-test-digiflazz";
const CALLBACK_URL = "/pay/digiflazz/callback";

async function enableDigiflazz() {
  await setSetting(prisma, DIGIFLAZZ_USERNAME_KEY, USERNAME);
  await setSetting(prisma, DIGIFLAZZ_API_KEY_KEY, API_KEY);
  await setEncryptedSetting(prisma, DIGIFLAZZ_WEBHOOK_SECRET_KEY, WEBHOOK_SECRET);
}
async function disableDigiflazz() {
  await deleteSetting(prisma, DIGIFLAZZ_USERNAME_KEY);
  await deleteSetting(prisma, DIGIFLAZZ_API_KEY_KEY);
}

function hubSignature(rawBody: string, secret = WEBHOOK_SECRET) {
  return `sha1=${createHmac("sha1", secret).update(rawBody).digest("hex")}`;
}

/** Raw body of a real Digiflazz prepaid webhook
 * (developer.digiflazz.com/api/buyer/webhook): the transaction sits under
 * `data`, and there is no signature field in the body at all. */
function webhookBody(args: { refId: string; status?: string; sn?: string; message?: string }) {
  const status = args.status ?? "Sukses";
  return JSON.stringify({
    data: {
      ref_id: args.refId,
      customer_no: "123456789",
      buyer_sku_code: "ml100",
      message: args.message ?? (status === "Sukses" ? "Transaksi Sukses" : status),
      status,
      rc: status === "Sukses" ? "00" : status === "Pending" ? "03" : "40",
      buyer_last_saldo: 0,
      sn: args.sn ?? "",
      price: 15000,
    },
  });
}

/** `app.inject` options for a delivery exactly as Digiflazz sends it:
 * `X-Hub-Signature: sha1=<HMAC-SHA1 of the raw body>` keyed by the webhook
 * secret, plus the event and user-agent headers. */
function signedPayload(args: {
  refId: string;
  status?: string;
  sn?: string;
  message?: string;
  event?: "create" | "update";
  secret?: string;
}) {
  const raw = webhookBody(args);
  return delivery(raw, hubSignature(raw, args.secret), args.event);
}

// Each test sends from its own simulated client IP (TRUST_PROXY trusts the
// loopback hop, see setup-env.ts) so this file's ~40 deliveries never trip
// the per-IP webhook rate limit (webhookRateLimited) meant for real abuse.
let deliveryIp = 0;
beforeEach(() => {
  deliveryIp++;
});

function delivery(raw: string, signature: string | undefined, event: "create" | "update" = "update") {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-digiflazz-event": event,
    "user-agent": "Digiflazz-Hookshot",
    "x-forwarded-for": `198.51.100.${deliveryIp % 250}`,
  };
  if (signature !== undefined) headers["x-hub-signature"] = signature;
  return { method: "POST" as const, url: CALLBACK_URL, payload: raw, headers };
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
 * lands on: already dispatched to Digiflazz by the poller, pending at the
 * supplier, next poller recheck scheduled a while out. `dispatch` overrides
 * those three fields for the Task B3d tests. */
async function createProcessingDigiflazzOrder(
  orderCode: string,
  totalAmount = "15000",
  dispatch: { digiflazzDispatchedAt?: Date | null; digiflazzStatus?: string | null; digiflazzNextRecheckAt?: Date | null } = {},
) {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: totalAmount,
      totalAmount,
      status: "PROCESSING",
      currency: "IDR",
      paymentMethod: "TOKOPAY",
      digiflazzDispatchedAt: new Date(Date.now() - 60_000),
      digiflazzStatus: "pending_at_supplier",
      digiflazzNextRecheckAt: new Date(Date.now() + 30 * 60_000),
      ...dispatch,
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

/**
 * Digiflazz's real webhook scheme: `X-Hub-Signature: sha1=<hex>`, HMAC-SHA1
 * of the RAW body keyed by the dashboard-configured webhook secret. Before
 * this, the route checked an invented md5(ref_id:apiKey) body field Digiflazz
 * never sends, so every real delivery was refused with 403 and paid orders
 * waited on the slow poller.
 */
describe("Digiflazz webhook signature (X-Hub-Signature, HMAC-SHA1 over the raw body)", () => {
  const live = (refId: string, status: "Sukses" | "Pending", sn: string | null = null) => ({
    refId,
    status,
    sn,
    message: null,
    price: null,
  });

  it("accepts a correctly signed `create` delivery and delivers on a live Sukses", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-SIG-CREATE");
    digiflazzSupplierMock.createTransaction.mockResolvedValue(live(order.orderCode, "Sukses", "SN-CREATE"));
    const res = await app.inject(signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-CREATE", event: "create" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(decryptDeliveredContent(updated!.deliveredContent, order.id)).toBe("SN-CREATE");
  });

  it("accepts a correctly signed `update` delivery reporting Pending and keeps the order PROCESSING", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-SIG-UPDATE", "15000", {
      digiflazzNextRecheckAt: new Date(Date.now() - 1_000),
    });
    digiflazzSupplierMock.createTransaction.mockResolvedValue(live(order.orderCode, "Pending"));
    const res = await app.inject(signedPayload({ refId: order.orderCode, status: "Pending", event: "update" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    expect(digiflazzSupplierMock.createTransaction).toHaveBeenCalledTimes(1);
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  it("403s a delivery signed with a different secret, without looking the order up", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-SIG-WRONGKEY");
    const res = await app.inject(signedPayload({ refId: order.orderCode, secret: "not-the-shop-secret" }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });

  it("403s a body that was changed after it was signed", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-SIG-TAMPER");
    const raw = webhookBody({ refId: order.orderCode, status: "Gagal", message: "Gagal" });
    const signature = hubSignature(raw);
    const tampered = raw.replace('"status":"Gagal"', '"status":"Sukses"');
    expect(tampered).not.toBe(raw);
    const res = await app.inject(delivery(tampered, signature));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  it("verifies the exact bytes received, not a re-serialization of the parsed JSON", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-SIG-BYTES");
    digiflazzSupplierMock.createTransaction.mockResolvedValue(live(order.orderCode, "Sukses", "SN-BYTES"));
    // Pretty-printed with a trailing newline: JSON.stringify(req.body) would
    // produce different bytes, so this only passes if the raw body is hashed.
    const raw = `${JSON.stringify(JSON.parse(webhookBody({ refId: order.orderCode, sn: "SN-BYTES" })), null, 2)}\n`;
    const res = await app.inject(delivery(raw, hubSignature(raw)));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["garbage", "sha1=zzzz"],
    ["truncated", "sha1=abc123"],
  ])("403s a delivery whose X-Hub-Signature header is %s", async (_label, header) => {
    const raw = webhookBody({ refId: "ORD-DF-SIG-HEADER" });
    const res = await app.inject(delivery(raw, header));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });

  it("403s a correct digest sent without the sha1= prefix", async () => {
    const raw = webhookBody({ refId: "ORD-DF-SIG-NOPREFIX" });
    const res = await app.inject(delivery(raw, hubSignature(raw).slice("sha1=".length)));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
  });

  it("403s the old invented md5 body-field scheme (no fallback)", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-SIG-OLDMD5");
    const res = await app.inject({
      method: "POST",
      url: CALLBACK_URL,
      payload: {
        ref_id: order.orderCode,
        status: "Sukses",
        sn: "SN-OLD",
        signature: createHash("md5").update(`${order.orderCode}:${API_KEY}`).digest("hex"),
      },
    });
    expect(res.statusCode).toBe(403);
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });

  it("never logs the webhook secret, the signature or the body of a rejected delivery", async () => {
    const warn = vi.spyOn(logger, "warn");
    const raw = webhookBody({ refId: "ORD-DF-SIG-NOLEAK" });
    const badSignature = hubSignature(raw, "attacker-key");
    try {
      const res = await app.inject(delivery(raw, badSignature));
      expect(res.statusCode).toBe(403);
      const logged = JSON.stringify(warn.mock.calls);
      expect(warn).toHaveBeenCalled();
      expect(logged).not.toContain(WEBHOOK_SECRET);
      expect(logged).not.toContain(badSignature.slice("sha1=".length));
      expect(logged).not.toContain("ORD-DF-SIG-NOLEAK");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs digiflazz.webhook_received for a verified delivery with the ref, status and time since dispatch, and nothing secret", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-TIMING-OK", "15000", {
      digiflazzDispatchedAt: new Date(Date.now() - 5_000),
    });
    digiflazzSupplierMock.createTransaction.mockResolvedValue(live(order.orderCode, "Sukses", "SN-TIMING"));
    const info = vi.spyOn(logger, "info");
    const raw = webhookBody({ refId: order.orderCode, status: "Sukses", sn: "SN-TIMING" });
    const signature = hubSignature(raw);
    try {
      const res = await app.inject(delivery(raw, signature));
      expect(res.statusCode).toBe(200);
      const received = info.mock.calls.filter(
        (c) => c[0] && typeof c[0] === "object" && (c[0] as { event?: string }).event === "digiflazz.webhook_received",
      );
      expect(received).toHaveLength(1);
      expect(received[0]![0]).toEqual({
        event: "digiflazz.webhook_received",
        orderId: order.id,
        orderCode: order.orderCode,
        refId: order.orderCode,
        callbackStatus: "Sukses",
        msSinceDispatch: expect.any(Number),
      });
      expect((received[0]![0] as { msSinceDispatch: number }).msSinceDispatch).toBeGreaterThanOrEqual(5_000);
      expect(String(received[0]![1])).toContain(order.orderCode);
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain(WEBHOOK_SECRET);
      expect(logged).not.toContain(signature.slice("sha1=".length));
      expect(logged).not.toContain(API_KEY);
      expect(logged).not.toContain("123456789"); // the body's customer_no
    } finally {
      info.mockRestore();
    }
  });

  it.each([
    ["an HTTP 400", () => new DigiflazzRequestError("Digiflazz transaction HTTP 400", "http_4xx", 400)],
    ["a reply without transaction data", () => new DigiflazzRequestError("Digiflazz transaction rejected: missing data in response", "rejected")],
  ])("a recheck that gets %s stays pending at the supplier, and a later signed Sukses webhook delivers the order", async (_label, makeError) => {
    // Already submitted under its ref id: Digiflazz may be processing it.
    // Dispatched 5 s ago, so the backoff anchored on it puts the next recheck
    // in the future.
    const order = await createProcessingDigiflazzOrder(`ORD-DF-RECHECK-${makeError().kind}`, "15000", {
      digiflazzDispatchedAt: new Date(Date.now() - 5_000),
      digiflazzNextRecheckAt: new Date(Date.now() - 1_000),
    });
    await prisma.order.update({ where: { id: order.id }, data: { digiflazzAttempts: 1 } });
    digiflazzSupplierMock.createTransaction.mockRejectedValueOnce(makeError());

    await dispatchDigiflazzOrderNow(prisma, order.id);
    const afterRecheck = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterRecheck.status).toBe("PROCESSING");
    expect(afterRecheck.digiflazzStatus).toBe("pending_at_supplier");
    expect(afterRecheck.digiflazzAttempts).toBe(2);
    expect(afterRecheck.digiflazzNextRecheckAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.auditLog.count({ where: { action: "order.digiflazz_dispatch_failed", targetId: order.id } })).toBe(0);

    // Digiflazz finishes the purchase and calls back (after the scheduled
    // recheck time, so the webhook is not refused by the in-flight lease).
    await prisma.order.update({ where: { id: order.id }, data: { digiflazzNextRecheckAt: new Date(Date.now() - 1_000) } });
    digiflazzSupplierMock.createTransaction.mockResolvedValue(live(order.orderCode, "Sukses", "SN-AFTER-RECHECK"));
    const res = await app.inject(signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-AFTER-RECHECK" }));
    expect(res.statusCode).toBe(200);

    const delivered = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(delivered.status).toBe("DELIVERED");
    expect(decryptDeliveredContent(delivered.deliveredContent, order.id)).toBe("SN-AFTER-RECHECK");
    const refIds = digiflazzSupplierMock.createTransaction.mock.calls.map((c) => (c[1] as { refId: string }).refId);
    expect(refIds).toEqual([order.orderCode, order.orderCode]);
  });

  it("does not log digiflazz.webhook_received for a delivery whose signature fails", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-TIMING-BAD");
    const info = vi.spyOn(logger, "info");
    try {
      const res = await app.inject(signedPayload({ refId: order.orderCode, secret: "not-the-shop-secret" }));
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(info.mock.calls)).not.toContain("digiflazz.webhook_received");
    } finally {
      info.mockRestore();
    }
  });
});

/**
 * Task B3d (backend audit): a signed delivery is replayable — the HMAC binds
 * the body but carries no timestamp or nonce — and every accepted callback re-POSTs
 * /transaction for the order. That re-POST is only a status check if
 * Digiflazz really dedups by ref_id (unverified, see createTransaction's
 * ASSUMPTION note). So the webhook must never be the one to place a FIRST
 * purchase, never re-check an order whose dispatch already failed, and never
 * run two re-checks of the same order at once.
 */
describe("Digiflazz callback replay cannot place a second purchase (Task B3d)", () => {
  const pending = (refId: string) => ({ refId, status: "Pending", sn: null, message: null, price: null });

  it("two concurrent replays of one callback run only one live re-check", async () => {
    // Dispatched just now, so the Pending outcome schedules the first recheck
    // (+10s) inside the claim lease: a replay landing after the first re-check
    // finished is still refused. A stale dispatch time would make that recheck
    // already due (new front-loaded schedule), which is legitimately claimable.
    const order = await createProcessingDigiflazzOrder("ORD-DF-B3D-RACE","15000", { digiflazzDispatchedAt: new Date() });
    digiflazzSupplierMock.createTransaction.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(pending(order.orderCode)), 150)),
    );
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-X" });

    const [a, b] = await Promise.all([
      app.inject(payload),
      app.inject(payload),
    ]);

    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(digiflazzSupplierMock.createTransaction).toHaveBeenCalledTimes(1);
  });

  it("never calls Digiflazz for an order the dispatch poller has not dispatched yet", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-B3D-UNDISPATCHED", "15000", {
      digiflazzDispatchedAt: null,
      digiflazzStatus: null,
      digiflazzNextRecheckAt: null,
    });
    const res = await app.inject(signedPayload({ refId: order.orderCode }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });

  it("never calls Digiflazz again for an order whose dispatch already failed terminally", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-B3D-FAILED", "15000", {
      digiflazzStatus: "failed",
      digiflazzNextRecheckAt: null,
    });
    const res = await app.inject(signedPayload({ refId: order.orderCode }));
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });

  it("does not re-check while the poller holds its in-flight claim lease on the order", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DF-B3D-LEASED", "15000", {
      digiflazzNextRecheckAt: new Date(Date.now() + 30_000), // inside the poller's 45-second claim lease
    });
    const res = await app.inject(signedPayload({ refId: order.orderCode }));
    expect(res.statusCode).toBe(200);
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /pay/digiflazz/callback", () => {
  it("403s when Digiflazz is disabled (no creds configured)", async () => {
    await disableDigiflazz();
    const payload = signedPayload({ refId: "ORD-DISABLED" });
    const res = await app.inject(payload);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
  });

  it("403s as disabled when the Digiflazz credentials are set but no webhook secret is configured", async () => {
    await deleteSetting(prisma, DIGIFLAZZ_WEBHOOK_SECRET_KEY);
    const order = await createProcessingDigiflazzOrder("ORD-DF-NOSECRET");
    // Even a delivery "signed" with an empty key must not get through.
    const res = await app.inject(signedPayload({ refId: order.orderCode, secret: "" }));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
  });

  it("returns unmatched when no order matches the ref_id", async () => {
    const payload = signedPayload({ refId: "ORD-NO-SUCH-ORDER" });
    const res = await app.inject(payload);
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

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(decryptDeliveredContent(updated!.deliveredContent, order.id)).toBe("SN-12345"); // the live re-check's sn, not cb.sn

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_MANUAL_DELIVERED_DM" },
    });
    expect(dmRows).toHaveLength(0);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: order.userId } });
    expect(await prisma.fulfillmentMessage.findUnique({ where: { orderId: order.id } })).toMatchObject({ chatId: buyer.telegramId });
    expect(await prisma.orderItem.findMany({ where: { orderId: order.id } })).toEqual([expect.objectContaining({ status: "DELIVERED" })]);

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

    const first = await app.inject(payload);
    expect(first.json()).toEqual({ status: "ok" });

    // The order is DELIVERED after the first call, so the second replay is
    // now refused by the order.status !== PROCESSING guard before it ever
    // reaches the live re-check (review fix, post-Task-12) — a strictly
    // better outcome than the previous "call createTransaction again, then
    // rely on fulfillDigiflazzOrder's atomic claim to catch the race".
    const second = await app.inject(payload);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "unmatched" });
    expect(digiflazzSupplierMock.createTransaction).toHaveBeenCalledTimes(1); // not called again on replay

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(decryptDeliveredContent(updated!.deliveredContent, order.id)).toBe("SN-1"); // unchanged by the replay
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

    const res = await app.inject(payload);
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

    const res = await app.inject(payload);
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

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
    // Task 7: the Gagal branch now goes through recordDigiflazzOutcome (same
    // shared decision point the poller uses — see digiflazz.test.ts's D3
    // case for the identical assertion pattern) instead of an inline
    // alert-only call, so it also writes the terminal digiflazz* fields.
    expect(updated!.digiflazzStatus).toBe("failed");
    expect(updated!.digiflazzNextRecheckAt).toBeNull();
    expect(updated!.digiflazzFailureDetail).toContain("Saldo tidak cukup");

    const alertRow = await prisma.notificationOutbox.findFirst({ where: { orderId: order.id } });
    expect(alertRow).not.toBeNull();

    const auditRow = await prisma.auditLog.findFirst({
      where: { action: "order.digiflazz_dispatch_failed", targetId: order.id },
    });
    expect(auditRow).not.toBeNull();
  });

  it("a Gagal callback whose recordDigiflazzOutcome write throws still 200s instead of 500ing", async () => {
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

    vi.mocked(recordDigiflazzOutcome).mockImplementationOnce(() => {
      throw new Error("transient DB write failure");
    });

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  // Task 7: unlike before (a bare no-op comment), a Pending callback now
  // advances the same recordDigiflazzOutcome backoff schedule the poller
  // uses, so a webhook-driven Pending report stops being invisible to the
  // realtime status feature.
  it("a Pending callback advances the backoff schedule via recordDigiflazzOutcome and leaves the order PROCESSING", async () => {
    // Dispatched "now", so the recheck delta below is measured from the same
    // anchor recordDigiflazzOutcome uses (the order's dispatch time).
    const before = new Date();
    const order = await createProcessingDigiflazzOrder("ORD-DFPENDING", "15000", { digiflazzDispatchedAt: before });
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Pending",
      sn: null,
      message: null,
      price: null,
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Pending" });

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
    expect(updated!.digiflazzStatus).toBe("pending_at_supplier");
    expect(updated!.digiflazzAttempts).toBe(1);
    expect(updated!.digiflazzNextRecheckAt).not.toBeNull();
    // DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[0] ahead (digiflazzBackoff.ts) — same delta-check pattern as digiflazz.test.ts's
    // D2 case ("leaves a Pending order PROCESSING with the claim set").
    const deltaMs = updated!.digiflazzNextRecheckAt!.getTime() - before.getTime();
    // First recheck is due DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[0] after dispatch
    // (digiflazzBackoff.ts); a slow test run may only push it later (never
    // scheduled in the past), and it must stay far below the second step.
    expect(deltaMs).toBeGreaterThanOrEqual(DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[0] * 1000);
    expect(deltaMs).toBeLessThan(DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[2] * 1000);
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
      data: { status: "DELIVERED", deliveredContent: encryptDeliveredContent("SN-ALREADY", order.id), deliveredAt: new Date() },
    });
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-REPLAY" });

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    expect(digiflazzSupplierMock.createTransaction).not.toHaveBeenCalled();
    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(decryptDeliveredContent(updated!.deliveredContent, order.id)).toBe("SN-ALREADY"); // unchanged by the replay
  });

  // Task 12 (I-4): a validly-signed callback naming an order that isn't
  // actually Digiflazz-routed (e.g. a plain manual order) must be refused
  // before any live re-check is attempted — resolveSingleDigiflazzItem's
  // guard, not a bare "order found" check.
  it("returns unmatched for a validly-signed callback naming an order that isn't Digiflazz-routed, without calling the live re-check", async () => {
    const order = await createProcessingPlainOrder("ORD-DFNOTDIGI");
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    const res = await app.inject(payload);
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
  // Task 7: unlike before (a complete no-op on the digiflazz* fields), the
  // live re-check's HTTP call itself throwing is now recorded via
  // recordDigiflazzOutcome's "transient_error" kind — the same retryable
  // treatment dispatchPendingDigiflazzOrders' own catch block gives an
  // in-flight HTTP failure — while still never surfacing as an HTTP 500.
  it("leaves the order PROCESSING, records a retryable transient error, and still 200s when the live re-check itself throws", async () => {
    const before = new Date();
    const order = await createProcessingDigiflazzOrder("ORD-DFLIVEFAIL", "15000", { digiflazzDispatchedAt: before });
    digiflazzSupplierMock.createTransaction.mockRejectedValue(new Error("Digiflazz transaction failed: request timed out"));
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
    expect(updated!.deliveredContent).toBeNull();
    expect(updated!.digiflazzStatus).toBe("pending_at_supplier");
    expect(updated!.digiflazzAttempts).toBe(1);
    expect(updated!.digiflazzNextRecheckAt).not.toBeNull();
    const deltaMs = updated!.digiflazzNextRecheckAt!.getTime() - before.getTime();
    // First recheck is due DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[0] after dispatch
    // (digiflazzBackoff.ts); a slow test run may only push it later (never
    // scheduled in the past), and it must stay far below the second step.
    expect(deltaMs).toBeGreaterThanOrEqual(DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[0] * 1000);
    expect(deltaMs).toBeLessThan(DIGIFLAZZ_RECHECK_SCHEDULE_SECONDS[2] * 1000);
    expect(updated!.digiflazzFailureDetail).toContain("Digiflazz transaction failed: request timed out");
  });

  // Regression guard (review of Task 7's first pass): the transient-error
  // catch's own recordDigiflazzOutcome call was originally unguarded, so a
  // failure writing that outcome (e.g. the DB update itself) would propagate
  // out of the route handler uncaught and surface as an HTTP 500 — telling
  // Digiflazz to retry-storm this endpoint, exactly what this whole handler
  // exists to avoid. Mirrors the sibling "Gagal callback whose
  // recordDigiflazzOutcome write throws still 200s" test above.
  it("a live-re-check-throws callback whose recordDigiflazzOutcome write also throws still 200s instead of 500ing", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFLIVEFAILTHROWS");
    digiflazzSupplierMock.createTransaction.mockRejectedValue(new Error("Digiflazz transaction failed: request timed out"));
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    vi.mocked(recordDigiflazzOutcome).mockImplementationOnce(() => {
      throw new Error("transient DB write failure");
    });

    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });

  // Task 7 cross-entry-point proof: the poller (dispatchPendingDigiflazzOrders)
  // and this webhook's live re-check both funnel into the SAME
  // recordDigiflazzOutcome — this test proves that claim is real by having
  // the poller dispatch an order to Pending first (digiflazzAttempts -> 1),
  // then sending this webhook a Pending callback for the SAME order and
  // checking digiflazzAttempts continues to 2 rather than resetting to 1,
  // which would only happen if the webhook ran its own independent counter.
  it("a webhook Pending report picks up where the poller's own dispatch left off (shared attempt/backoff schedule, not reset)", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFCONTINUE", "15000", {
      digiflazzDispatchedAt: null,
      digiflazzStatus: null,
      digiflazzNextRecheckAt: null,
    });
    digiflazzSupplierMock.createTransaction.mockResolvedValue({
      refId: order.orderCode,
      status: "Pending",
      sn: null,
      message: null,
      price: null,
    });

    // The dispatch poller places THIS order and gets Pending back —
    // digiflazzAttempts becomes 1, mirroring digiflazz.test.ts's "leaves a
    // Pending order PROCESSING with the claim set" case. Only this test's
    // own order is asserted on below — dispatchPendingDigiflazzOrders scans
    // the whole orders table, so other PROCESSING digiflazz-routed orders
    // left behind by earlier tests in this file may also get swept up in
    // the same pass; that doesn't affect this order's row.
    await dispatchPendingDigiflazzOrders(prisma);
    const afterDispatch = await prisma.order.findUnique({ where: { id: order.id } });
    expect(afterDispatch!.digiflazzStatus).toBe("pending_at_supplier");
    expect(afterDispatch!.digiflazzAttempts).toBe(1);
    expect(afterDispatch!.digiflazzDispatchedAt).not.toBeNull();

    // The callback arrives once the poller's first backoff has elapsed (a
    // callback inside the window right before a scheduled recheck is left to
    // that recheck — Task B3d, claimDigiflazzWebhookRecheck).
    await prisma.order.update({ where: { id: order.id }, data: { digiflazzNextRecheckAt: new Date(Date.now() - 1_000) } });

    // Now this webhook's own live re-check ALSO reports Pending for the same
    // order — recordDigiflazzOutcome must continue the same attempt counter/
    // backoff schedule the poller started (1 -> 2), not restart a second
    // independent one.
    const payload = signedPayload({ refId: order.orderCode, status: "Pending" });
    const res = await app.inject(payload);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
    expect(updated!.digiflazzStatus).toBe("pending_at_supplier");
    expect(updated!.digiflazzAttempts).toBe(2); // continued, not reset to 1
    expect(updated!.digiflazzDispatchedAt).toEqual(afterDispatch!.digiflazzDispatchedAt); // same dispatch anchor, unchanged
  });
});
