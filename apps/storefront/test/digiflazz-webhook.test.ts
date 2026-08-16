// Digiflazz webhook (POST /pay/digiflazz/callback) — Task 3 (original pilot
// plan). Deliberately simpler trust model than the TokoPay/PayDisini/
// NOWPayments callbacks in this directory: verifyCallback's signature check
// (@app/core/suppliers/digiflazz) IS the trust boundary — no live
// re-confirmation call, no amount/short-payment check, no ledger dedup table.
// Idempotency instead comes from fulfillDigiflazzOrder's own atomic
// PROCESSING -> DELIVERED claim (packages/db/src/crud/digiflazz.ts). Pattern:
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

  it("happy path: a Sukses callback delivers the order and enqueues the buyer's receipt DM", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFHAPPY");
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-12345" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(updated!.deliveredContent).toBe("SN-12345");

    const dmRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ORDER_MANUAL_DELIVERED_DM" },
    });
    expect(dmRows.length).toBeGreaterThan(0);
  });

  it("is idempotent: a replayed/duplicate Sukses callback for an already-delivered order still 200s without re-delivering", async () => {
    const order = await createProcessingDigiflazzOrder("ORD-DFREPLAY");
    const payload = signedPayload({ refId: order.orderCode, status: "Sukses", sn: "SN-1" });

    const first = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(first.json()).toEqual({ status: "ok" });

    const second = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "ok" }); // fulfillDigiflazzOrder's race is caught, not surfaced as an error

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");
    expect(updated!.deliveredContent).toBe("SN-1"); // unchanged by the replay
  });

  it("a Gagal callback enqueues an admin alert and leaves the order PROCESSING", async () => {
    await setSetting(prisma, ADMIN_IDS_KEY, "555");
    const order = await createProcessingDigiflazzOrder("ORD-DFGAGAL");
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
    const payload = signedPayload({ refId: order.orderCode, status: "Pending" });

    const res = await app.inject({ method: "POST", url: "/pay/digiflazz/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PROCESSING");
  });
});
