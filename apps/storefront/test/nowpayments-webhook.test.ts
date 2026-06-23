// NOWPayments IPN webhook (POST /pay/nowpayments/callback) — DIFFERS from the
// TokoPay/PayDisini callback (apps/storefront/test/paydisini-webhook.test.ts)
// in exactly one respect: the signature arrives via the HTTP header
// `x-nowpayments-sig` (HMAC-SHA512 over the recursively-key-sorted JSON body),
// not a body field. Same response contract otherwise: 403 disabled, 403 bad
// signature, 200 for every other outcome (ignored/unmatched/amount
// mismatch/delivered/delivery-failed) so the gateway always stops retrying
// except on a signature problem. Pattern: apps/storefront/test/paydisini-webhook.test.ts.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@app/core/mailer", () => ({
  sendMail: vi.fn().mockResolvedValue(undefined),
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
} from "@app/db";
// Import the REAL sort helper from the gateway client (rather than a
// hand-rolled re-implementation) so this test fails loudly if NOWPayments'
// recursive-key-sort logic ever changes/breaks instead of silently testing
// against a second, possibly-drifted copy.
import { sortKeysDeep } from "@app/core/payments/nowpayments";
import { buildApp } from "../src/server";

const API_KEY = "ak-test-nowpayments";
const IPN_SECRET = "ipn-secret-test-nowpayments";

async function enableNowpayments() {
  await setSetting(prisma, "nowpayments_api_key", API_KEY);
  await setSetting(prisma, "nowpayments_ipn_secret", IPN_SECRET);
  await setSetting(prisma, "nowpayments_pay_currency", "usdttrc20");
}
async function disableNowpayments() {
  await deleteSetting(prisma, "nowpayments_api_key");
  await deleteSetting(prisma, "nowpayments_ipn_secret");
  await deleteSetting(prisma, "nowpayments_pay_currency");
}

/** Build an IPN body + a REAL HMAC-SHA512-over-sorted-keys signature for it. */
function signedIpn(args: { orderId: string; amount: string; trxId?: string; status?: string }) {
  const body = {
    order_id: args.orderId,
    payment_id: args.trxId ?? `PID-${args.orderId}`,
    payment_status: args.status ?? "finished",
    actually_paid: args.amount,
    pay_amount: args.amount,
  };
  const signature = createHmac("sha512", IPN_SECRET).update(JSON.stringify(sortKeysDeep(body))).digest("hex");
  return { body, signature };
}

let app: FastifyInstance;
let userId: number;
let denomId: number;

beforeAll(async () => {
  await initDb();
  app = await buildApp();

  const cat = await prisma.category.create({
    data: { name: "NowpaymentsCat", slug: "nowpayments-cat", sortOrder: 1 },
  });
  const product = await createCatalogProduct(prisma, { categoryId: cat.id, name: "Webhook Test Product NP" });
  const denom = await createDenomination(prisma, {
    productId: product.id,
    name: "Webhook Test Product NP",
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
    data: { telegramId: null, referralCode: "NPWH01" },
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
  await enableNowpayments();
});

/** Create a PENDING_PAYMENT NOWPAYMENTS/USDT order directly (bypassing checkout/cart) for webhook-only tests. */
async function createPendingNowpaymentsOrder(orderCode: string, totalAmountUsdt: string) {
  return prisma.order.create({
    data: {
      orderCode,
      userId,
      subtotalAmount: totalAmountUsdt,
      totalAmount: totalAmountUsdt,
      status: "PENDING_PAYMENT",
      currency: "USDT",
      paymentMethod: "NOWPAYMENTS",
      paymentRef: JSON.stringify({ gateway: "nowpayments", invoiceId: `INV-${orderCode}`, invoiceUrl: "https://nowpayments.test/invoice/1" }),
      items: {
        create: [{ productId: denomId, quantity: 1, unitPrice: totalAmountUsdt, warrantyDaysSnapshot: 0 }],
      },
    },
  });
}

describe("POST /pay/nowpayments/callback", () => {
  it("403s when NOWPayments is disabled (no creds configured)", async () => {
    await disableNowpayments();
    const { body } = signedIpn({ orderId: "ORD-DISABLED", amount: "50" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": "irrelevant" },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
  });

  it("403s on a bad signature", async () => {
    const { body } = signedIpn({ orderId: "ORD-BADSIG", amount: "50" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": "0".repeat(128) },
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
  });

  it("403s when the signature header is missing entirely", async () => {
    const { body } = signedIpn({ orderId: "ORD-NOSIG", amount: "50" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      payload: body,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
  });

  it("happy path: delivers the order and marks it DELIVERED on a finished/paid IPN", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-NPHAPPY", "50");
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-HAPPY-1" });

    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "delivered" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");

    const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-HAPPY-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("matched");
  });

  it("is idempotent: replaying the same payment_id after delivery is a no-op (already_processed)", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-NPREPLAY", "50");
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-REPLAY-1" });

    const first = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "delivered" });

    const second = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_processed" });
  });

  it("records an unmatched tx when no NOWPAYMENTS order matches the order_id", async () => {
    const { body, signature } = signedIpn({ orderId: "ORD-NO-SUCH-ORDER", amount: "12.5", trxId: "PID-UNMATCHED-1" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-UNMATCHED-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("unmatched");
    expect(ledger!.orderId).toBeNull();
  });

  it("records unmatched (not delivered) when the order_id matches a non-NOWPAYMENTS order", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-WRONGMETHOD-NP",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "PENDING_PAYMENT",
        currency: "IDR",
        paymentMethod: "TOKOPAY", // not NOWPAYMENTS
      },
    });
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "50000", trxId: "PID-WRONGMETHOD-1" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  // Payment-4 (security audit, 2026-06-23): see tokopay-webhook.test.ts's
  // matching test for the rationale.
  it("records unmatched (not delivered) when the order_id matches a NOWPAYMENTS-method order whose currency is somehow not USDT", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-WRONGCURR-NP",
        userId,
        subtotalAmount: "50000",
        totalAmount: "50000",
        status: "PENDING_PAYMENT",
        currency: "IDR", // contrived: paymentMethod/currency decoupled
        paymentMethod: "NOWPAYMENTS",
      },
    });
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "50000", trxId: "PID-WRONGCURR-1" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  it("never delivers a short/underpaid amount — records unmatched instead", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-SHORTPAY-NP", "50");
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "40", trxId: "PID-SHORT-1" }); // less than totalAmount
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "amount mismatch" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // never delivered on a short payment

    const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-SHORT-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("unmatched");
  });

  it("ignores a non-finished (waiting/confirming/partially_paid) IPN without touching the order or ledger", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-PENDINGCB-NP", "50");
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-PENDING-1", status: "waiting" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
    const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-PENDING-1" } });
    expect(ledger).toBeNull();
  });

  it("ignores partially_paid (close-but-not-finished) without delivering — never an error condition", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-PARTIAL-NP", "50");
    const { body, signature } = signedIpn({ orderId: order.orderCode, amount: "49.99", trxId: "PID-PARTIAL-1", status: "partially_paid" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "x-nowpayments-sig": signature },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
  });
});
