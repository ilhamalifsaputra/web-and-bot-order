// PayDisini webhook (POST /pay/paydisini/callback) — mirrors the TokoPay
// callback contract byte-for-byte (checkout.ts): 403 disabled, 403 bad
// signature, 200 for every other outcome (ignored/unmatched/amount
// mismatch/delivered/delivery-failed) so the gateway always stops retrying
// except on a signature problem. Pattern: apps/storefront/test/storefront.test.ts.
//
// M-9 (backend audit 2026-07-31): PayDisini's signature
// (md5(apiKey:userKey:refId:amount)) doesn't cover `status`, so the route now
// re-confirms "paid" + amount live against PayDisini's API (`checkTransaction`)
// before trusting the callback body — checkTransaction is mocked here since it
// does a real network fetch. Pattern: apps/storefront/test/tokopay-webhook.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));

let mockCheckTransaction = vi.fn();
vi.mock("@app/core/payments/paydisini", async () => {
  const actual = await vi.importActual<typeof import("@app/core/payments/paydisini")>("@app/core/payments/paydisini");
  return {
    ...actual,
    checkTransaction: (...args: unknown[]) => mockCheckTransaction(...args),
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
} from "@app/db";
import { Decimal } from "@app/core/money";
import { buildApp } from "../src/server";

const USER_KEY = "uk-test-paydisini";
const API_KEY = "ak-test-paydisini";

async function enablePaydisini() {
  await setSetting(prisma, "paydisini_userkey", USER_KEY);
  await setSetting(prisma, "paydisini_apikey", API_KEY);
  await setSetting(prisma, "paydisini_default_channel", "QRIS");
}
async function disablePaydisini() {
  await deleteSetting(prisma, "paydisini_userkey");
  await deleteSetting(prisma, "paydisini_apikey");
  await deleteSetting(prisma, "paydisini_default_channel");
}

/** Build a callback payload + matching signature (md5(apiKey:userKey:refId:amount), per packages/core/src/payments/paydisini.ts). */
function signedPayload(args: { refId: string; amount: string; trxId?: string; status?: string }) {
  const signature = createHash("md5")
    .update(`${API_KEY}:${USER_KEY}:${args.refId}:${args.amount}`)
    .digest("hex");
  return {
    ref_id: args.refId,
    unique_code: args.trxId ?? `TRX-${args.refId}`,
    amount: args.amount,
    status: args.status ?? "Success",
    signature,
  };
}

/** Default live-status stub: agrees with whatever the callback body claimed. */
function liveAgrees(args: { amount: string; trxId?: string; paid?: boolean }) {
  return {
    paid: args.paid ?? true,
    amount: new Decimal(args.amount),
    trxId: args.trxId ?? null,
  };
}

let app: FastifyInstance;
let userId: number;
let denomId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "PaydisiniCat", slug: "paydisini-cat", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Webhook Test Product" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Webhook Test Product",
    type: "SHARED",
    durationLabel: "1 month",
    price: "50000",
  });
  denomId = denom.id;
  await prisma.stockItem.createMany({
    data: Array.from({ length: 5 }, () => ({
      productId: denom.id,
      credentials: "user@mail.com:pass",
      status: "AVAILABLE",
    })),
  });

  const user = await prisma.user.create({
    data: { telegramId: null, referralCode: "PDWH01" },
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
  await enablePaydisini();
  mockCheckTransaction = vi.fn();
});

/** Create a PENDING_PAYMENT PAYDISINI order directly (bypassing checkout/cart) for webhook-only tests. */
async function createPendingPaydisiniOrder(orderCode: string, totalAmount: string) {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: totalAmount,
      totalAmount,
      status: "PENDING_PAYMENT",
      currency: "IDR",
      paymentMethod: "PAYDISINI",
      items: {
        create: [{ productId: denomId, quantity: 1, unitPrice: totalAmount, warrantyDaysSnapshot: 0 }],
      },
    },
  });
}

describe("POST /pay/paydisini/callback", () => {
  it("403s when PayDisini is disabled (no creds configured)", async () => {
    await disablePaydisini();
    const payload = signedPayload({ refId: "ORD-DISABLED", amount: "50000" });
    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
  });

  it("403s on a bad signature (live status is never consulted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pay/paydisini/callback",
      payload: {
        ref_id: "ORD-BADSIG",
        unique_code: "TRX-BADSIG",
        amount: "50000",
        status: "Success",
        signature: "0000000000000000000000000000000",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();
  });

  it("happy path: delivers when the live status check confirms paid + matching amount", async () => {
    const order = await createPendingPaydisiniOrder("ORD-PDHAPPY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "50000", trxId: "TRX-HAPPY-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-HAPPY-1" });

    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "delivered" });
    expect(mockCheckTransaction).toHaveBeenCalledTimes(1);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");

    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-HAPPY-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("matched");
  });

  it("is idempotent: replaying the same trx id after delivery is a no-op (already_processed)", async () => {
    const order = await createPendingPaydisiniOrder("ORD-PDREPLAY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "50000", trxId: "TRX-REPLAY-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-REPLAY-1" });

    const first = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "delivered" });

    const second = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_processed" });
  });

  it("records an unmatched tx when no PAYDISINI order matches the ref_id (live check is skipped — no order)", async () => {
    const payload = signedPayload({ refId: "ORD-NO-SUCH-ORDER", amount: "12345", trxId: "TRX-UNMATCHED-1" });
    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-UNMATCHED-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("unmatched");
    expect(ledger!.orderId).toBeNull();
  });

  it("records unmatched (not delivered) when the ref_id matches a non-PAYDISINI order", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-WRONGMETHOD",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "PENDING_PAYMENT",
        currency: "IDR",
        paymentMethod: "TOKOPAY", // not PAYDISINI
      },
    });
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-WRONGMETHOD-1" });
    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  // Payment-4 (security audit, 2026-06-23): see tokopay-webhook.test.ts's
  // matching test for the rationale.
  it("records unmatched (not delivered) when the ref_id matches a PAYDISINI-method order whose currency is somehow not IDR", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-WRONGCURR",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "PENDING_PAYMENT",
        currency: "USDT", // contrived: paymentMethod/currency decoupled
        paymentMethod: "PAYDISINI",
      },
    });
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-WRONGCURR-1" });
    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  it("overpaid: delivers, ledger outcome is overpaid, and enqueues ADMIN_OVERPAID rows for each ADMIN_IDS entry", async () => {
    const order = await createPendingPaydisiniOrder("ORD-OVERPAY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "75000", trxId: "TRX-OVERPAY-1" })); // 25000 over
    const payload = signedPayload({ refId: order.orderCode, amount: "75000", trxId: "TRX-OVERPAY-1" });

    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "delivered" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");

    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-OVERPAY-1" } });
    expect(ledger!.outcome).toBe("overpaid");

    // ADMIN_IDS = "999,1000" (setup-env.ts) -> one ADMIN_OVERPAID row per admin.
    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ADMIN_OVERPAID" },
      orderBy: { id: "asc" },
    });
    expect(adminRows.length).toBe(2);
    const chatIds = adminRows.map((r) => JSON.parse(r.payloadJson).chat_id).sort((a, b) => a - b);
    expect(chatIds).toEqual([999, 1000]);
    for (const row of adminRows) {
      const p = JSON.parse(row.payloadJson) as Record<string, unknown>;
      expect(p.order_code).toBe(order.orderCode);
      expect(p.paid).toBe("75000");
      expect(p.expected).toBe("50000");
      expect(p.excess).toBe("25000");
      expect(p.currency).toBe("IDR");
    }
  });

  it("replaying an overpaid callback is idempotent — no duplicate ADMIN_OVERPAID rows", async () => {
    const order = await createPendingPaydisiniOrder("ORD-OVERPAY-REPLAY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "60000", trxId: "TRX-OVERPAY-REPLAY-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "60000", trxId: "TRX-OVERPAY-REPLAY-1" });

    const first = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(first.json()).toEqual({ status: "delivered" });

    const second = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(second.json()).toEqual({ status: "already_processed" });

    const adminRows = await prisma.notificationOutbox.findMany({
      where: { orderId: order.id, event: "ADMIN_OVERPAID" },
    });
    expect(adminRows.length).toBe(2); // still one per admin, not doubled by the replay
  });

  it("never delivers a short/underpaid amount — records unmatched instead", async () => {
    const order = await createPendingPaydisiniOrder("ORD-SHORTPAY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "40000", trxId: "TRX-SHORT-1" })); // less than totalAmount
    const payload = signedPayload({ refId: order.orderCode, amount: "40000", trxId: "TRX-SHORT-1" });
    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "amount mismatch" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // never delivered on a short payment

    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-SHORT-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("unmatched");
  });

  it("uses the LIVE amount for the short-payment check, not the (unsigned) callback body amount", async () => {
    const order = await createPendingPaydisiniOrder("ORD-LIVESHORT", "50000");
    // Callback body claims full payment, but the live gateway only confirms a
    // smaller amount — must not deliver on the inflated body value.
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "40000", trxId: "TRX-LIVESHORT-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-LIVESHORT-1" });

    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "amount mismatch" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");

    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-LIVESHORT-1" } });
    expect(ledger!.outcome).toBe("unmatched");
  });

  // M-9 (backend audit 2026-07-31): this is the exact attack the fix closes.
  // PayDisini's signature is md5(apiKey:userKey:refId:amount) — it does NOT
  // cover `status`, so an attacker who can compute (or replay) a valid
  // signature for a known refId+amount can set `status` to "Success" freely.
  // The live status check (server-to-server, using the merchant credentials)
  // must be the actual source of truth, not the unsigned body `status` field.
  it("a forged callback body (status: Success) is rejected when the live check reports not actually paid", async () => {
    const order = await createPendingPaydisiniOrder("ORD-FORGED", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "0", paid: false })); // gateway says: not actually paid
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", status: "Success", trxId: "TRX-FORGED-1" });

    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "not confirmed live" });
    expect(mockCheckTransaction).toHaveBeenCalledTimes(1);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // never delivered

    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-FORGED-1" } });
    expect(ledger).toBeNull(); // not even recorded as unmatched — just ignored until the poller confirms
  });

  it("gracefully handles a live-status-check failure (e.g. gateway timeout) without delivering", async () => {
    const order = await createPendingPaydisiniOrder("ORD-LIVEFAIL", "50000");
    mockCheckTransaction.mockRejectedValue(new Error("network timeout"));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-LIVEFAIL-1" });

    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "status check failed" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
  });

  it("ignores a non-paid (pending/failed) callback without ever calling the live status check", async () => {
    const order = await createPendingPaydisiniOrder("ORD-PENDINGCB", "50000");
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-PENDING-1", status: "Pending" });
    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
    const ledger = await prisma.processedPaydisiniTx.findUnique({ where: { trxId: "TRX-PENDING-1" } });
    expect(ledger).toBeNull();
  });

  // M-10 (backend audit 2026-07-31): the order left PENDING_PAYMENT (here,
  // simulating autoCancelExpiredOrders having already cancelled it) between
  // this webhook arriving and deliverPaidPaydisiniOrder's transaction
  // running. No poller can recover this either, so it must alert an admin
  // rather than silently doing nothing.
  it("logs a warning and enqueues an ADMIN_STALE_PAYMENT alert when the order left PENDING_PAYMENT before delivery ran", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-PDSTALE",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "CANCELLED", // no longer PENDING_PAYMENT by the time the webhook's delivery transaction runs
        currency: "IDR",
        paymentMethod: "PAYDISINI",
      },
    });
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "50000", trxId: "TRX-PDSTALE-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-PDSTALE-1" });

    const res = await app.inject({ method: "POST", url: "/pay/paydisini/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "stale" });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: "ADMIN_STALE_PAYMENT", orderId: order.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    const alert = JSON.parse(rows[0]!.payloadJson) as { order_code: string; gateway: string; trx_id: string };
    expect(alert.order_code).toBe("ORD-PDSTALE");
    expect(alert.gateway).toBe("PayDisini");
    expect(alert.trx_id).toBe("TRX-PDSTALE-1");
  });
});
