// TokoPay webhook (POST /pay/tokopay/callback) — mirrors paydisini-webhook.test.ts
// EXCEPT for one deliberate hardening difference: TokoPay's signature
// (md5(merchantId:secret:refId)) doesn't cover amount/status (see the ⚠
// ASSUMPTION note in packages/core/src/payments/tokopay.ts), so the route
// re-confirms "paid" + amount live against TokoPay's API (`checkTransaction`)
// before trusting the callback body — checkTransaction is mocked here since it
// does a real network fetch. Pattern: apps/storefront/test/paydisini-webhook.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
}));

let mockCheckTransaction = vi.fn();
vi.mock("@app/core/payments/tokopay", async () => {
  const actual = await vi.importActual<typeof import("@app/core/payments/tokopay")>("@app/core/payments/tokopay");
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

const MERCHANT_ID = "m-test-tokopay";
const SECRET = "s-test-tokopay";

async function enableTokopay() {
  await setSetting(prisma, "tokopay_merchant_id", MERCHANT_ID);
  await setSetting(prisma, "tokopay_secret", SECRET);
  await setSetting(prisma, "tokopay_default_channel", "QRIS");
}
async function disableTokopay() {
  await deleteSetting(prisma, "tokopay_merchant_id");
  await deleteSetting(prisma, "tokopay_secret");
  await deleteSetting(prisma, "tokopay_default_channel");
}

/** Build a callback payload + a REAL signature (md5(merchantId:secret:refId), per packages/core/src/payments/tokopay.ts). Deliberately does NOT cover amount/status. */
function signedPayload(args: { refId: string; amount: string; trxId?: string; status?: string }) {
  const signature = createHash("md5").update(`${MERCHANT_ID}:${SECRET}:${args.refId}`).digest("hex");
  return {
    ref_id: args.refId,
    trx_id: args.trxId ?? `TRX-${args.refId}`,
    nominal: args.amount,
    status: args.status ?? "success",
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
    data: { name: "TokopayCat", slug: "tokopay-cat", sortOrder: 1 },
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
    data: { telegramId: null, referralCode: "TPWH01" },
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
  await enableTokopay();
  mockCheckTransaction = vi.fn();
});

/** Create a PENDING_PAYMENT TOKOPAY order directly (bypassing checkout/cart) for webhook-only tests. */
async function createPendingTokopayOrder(orderCode: string, totalAmount: string) {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: totalAmount,
      totalAmount,
      status: "PENDING_PAYMENT",
      currency: "IDR",
      paymentMethod: "TOKOPAY",
      items: {
        create: [{ productId: denomId, quantity: 1, unitPrice: totalAmount, warrantyDaysSnapshot: 0 }],
      },
    },
  });
}

describe("POST /pay/tokopay/callback", () => {
  it("403s when TokoPay is disabled (no creds configured)", async () => {
    await disableTokopay();
    const payload = signedPayload({ refId: "ORD-DISABLED", amount: "50000" });
    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
  });

  it("403s on a bad signature (live status is never consulted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/pay/tokopay/callback",
      payload: {
        ref_id: "ORD-BADSIG",
        trx_id: "TRX-BADSIG",
        nominal: "50000",
        status: "success",
        signature: "0000000000000000000000000000000",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();
  });

  it("happy path: delivers when the live status check confirms paid + matching amount", async () => {
    const order = await createPendingTokopayOrder("ORD-TPHAPPY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "50000", trxId: "TRX-HAPPY-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-HAPPY-1" });

    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "delivered" });
    expect(mockCheckTransaction).toHaveBeenCalledTimes(1);

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");

    const ledger = await prisma.processedTokopayTx.findUnique({ where: { trxId: "TRX-HAPPY-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("matched");
  });

  it("a forged callback body (paid=success, fake high amount) is rejected when the live check disagrees", async () => {
    // This is the exact attack the fix closes: the signature only covers
    // merchantId:secret:refId, so an attacker who can replay/compute a valid
    // signature for a known refId could set nominal/status to anything. The
    // live status check (using the merchant secret server-to-server) must be
    // the actual source of truth, not the unsigned body fields.
    const order = await createPendingTokopayOrder("ORD-FORGED", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "0", paid: false })); // gateway says: not actually paid
    const payload = signedPayload({ refId: order.orderCode, amount: "999999999", status: "success", trxId: "TRX-FORGED-1" });

    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "not confirmed live" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // never delivered
  });

  it("uses the LIVE amount for the short-payment check, not the (unsigned) callback body amount", async () => {
    const order = await createPendingTokopayOrder("ORD-LIVESHORT", "50000");
    // Callback body claims full payment, but the live gateway only confirms a
    // smaller amount — must not deliver on the inflated body value.
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "40000", trxId: "TRX-LIVESHORT-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-LIVESHORT-1" });

    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "amount mismatch" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");

    const ledger = await prisma.processedTokopayTx.findUnique({ where: { trxId: "TRX-LIVESHORT-1" } });
    expect(ledger!.outcome).toBe("unmatched");
  });

  it("is idempotent: replaying the same trx id after delivery is a no-op (already_processed)", async () => {
    const order = await createPendingTokopayOrder("ORD-TPREPLAY", "50000");
    mockCheckTransaction.mockResolvedValue(liveAgrees({ amount: "50000", trxId: "TRX-REPLAY-1" }));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-REPLAY-1" });

    const first = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(first.json()).toEqual({ status: "delivered" });

    const second = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(second.json()).toEqual({ status: "already_processed" });
  });

  it("records an unmatched tx when no TOKOPAY order matches the ref_id (live check is skipped — no order)", async () => {
    const payload = signedPayload({ refId: "ORD-NO-SUCH-ORDER", amount: "12345", trxId: "TRX-UNMATCHED-1" });
    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const ledger = await prisma.processedTokopayTx.findUnique({ where: { trxId: "TRX-UNMATCHED-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("unmatched");
    expect(ledger!.orderId).toBeNull();
  });

  it("records unmatched (not delivered) when the ref_id matches a non-TOKOPAY order", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-WRONGMETHOD",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "PENDING_PAYMENT",
        currency: "IDR",
        paymentMethod: "PAYDISINI", // not TOKOPAY
      },
    });
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-WRONGMETHOD-1" });
    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  // Payment-4 (security audit, 2026-06-23): paymentMethod implies currency in
  // normal operation (finalizeOrderPayment always stamps both together), but
  // the route now cross-checks currency explicitly so a future bug that
  // decouples them can never compare a TokoPay callback amount against a
  // USDT-denominated order.
  it("records unmatched (not delivered) when the ref_id matches a TOKOPAY-method order whose currency is somehow not IDR", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-WRONGCURR",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "PENDING_PAYMENT",
        currency: "USDT", // contrived: paymentMethod/currency decoupled
        paymentMethod: "TOKOPAY",
      },
    });
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-WRONGCURR-1" });
    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  it("ignores a non-paid (pending/failed) callback without ever calling the live status check", async () => {
    const order = await createPendingTokopayOrder("ORD-PENDINGCB", "50000");
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-PENDING-1", status: "pending" });
    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });
    expect(mockCheckTransaction).not.toHaveBeenCalled();

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
    const ledger = await prisma.processedTokopayTx.findUnique({ where: { trxId: "TRX-PENDING-1" } });
    expect(ledger).toBeNull();
  });

  it("gracefully handles a live-status-check failure (e.g. gateway timeout) without delivering", async () => {
    const order = await createPendingTokopayOrder("ORD-LIVEFAIL", "50000");
    mockCheckTransaction.mockRejectedValue(new Error("network timeout"));
    const payload = signedPayload({ refId: order.orderCode, amount: "50000", trxId: "TRX-LIVEFAIL-1" });

    const res = await app.inject({ method: "POST", url: "/pay/tokopay/callback", payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "status check failed" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
  });
});
