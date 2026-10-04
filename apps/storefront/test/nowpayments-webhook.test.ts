// NOWPayments IPN webhook (POST /pay/nowpayments/callback) — DIFFERS from the
// TokoPay/PayDisini callback (apps/storefront/test/paydisini-webhook.test.ts)
// in exactly one respect: the signature arrives via the HTTP header
// `x-nowpayments-sig` (HMAC-SHA512 over the RAW request body bytes — Task 2a
// fix, see nowpayments.ts's top doc comment), not a body field. Same response
// contract otherwise: 403 disabled, 403 bad signature, 200 for every other
// outcome (ignored/unmatched/amount mismatch/delivered/delivery-failed) so
// the gateway always stops retrying except on a signature problem. Pattern:
// apps/storefront/test/paydisini-webhook.test.ts.
//
// Because the signature now covers the literal wire bytes, every `app.inject`
// call below sends `payload: raw` (a STRING, built by `JSON.stringify` from
// this test file, standing in for NOWPayments' own serialization) with an
// explicit `content-type: application/json` header — never a bare object —
// so light-my-request doesn't re-serialize it itself, and the signature is
// computed over that exact same string.
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

/**
 * Build a raw IPN JSON string (standing in for NOWPayments' own wire bytes)
 * + a REAL HMAC-SHA512-over-the-raw-bytes signature for it (Task 2a fix —
 * the webhook now hashes the exact request body, not a re-serialization).
 */
function signedIpn(args: {
  orderId: string;
  amount: string;
  trxId?: string;
  status?: string;
  /** Defaults to `amount` (a USDT pay currency quoted 1:1). `null` omits it. */
  payAmount?: string | null;
  /** Defaults to `amount`. `null` omits the field. */
  priceAmount?: string | null;
  /** Defaults to "usd" (what createInvoice always sends). `null` omits it. */
  priceCurrency?: string | null;
  payCurrency?: string;
}) {
  const body: Record<string, unknown> = {
    order_id: args.orderId,
    payment_id: args.trxId ?? `PID-${args.orderId}`,
    payment_status: args.status ?? "finished",
    actually_paid: args.amount,
    pay_currency: args.payCurrency ?? "usdttrc20",
  };
  const payAmount = args.payAmount === undefined ? args.amount : args.payAmount;
  if (payAmount !== null) body.pay_amount = payAmount;
  const priceAmount = args.priceAmount === undefined ? args.amount : args.priceAmount;
  if (priceAmount !== null) body.price_amount = priceAmount;
  const priceCurrency = args.priceCurrency === undefined ? "usd" : args.priceCurrency;
  if (priceCurrency !== null) body.price_currency = priceCurrency;
  const raw = JSON.stringify(body);
  const signature = createHmac("sha512", IPN_SECRET).update(raw).digest("hex");
  return { body, raw, signature };
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
    data: Array.from({ length: 15 }, () => ({
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
    const { raw } = signedIpn({ orderId: "ORD-DISABLED", amount: "50" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": "irrelevant" },
      payload: raw,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "disabled" });
  });

  it("403s on a bad signature", async () => {
    const { raw } = signedIpn({ orderId: "ORD-BADSIG", amount: "50" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": "0".repeat(128) },
      payload: raw,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
  });

  it("403s when the signature header is missing entirely", async () => {
    const { raw } = signedIpn({ orderId: "ORD-NOSIG", amount: "50" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      // Still need content-type: application/json so the body parses (the
      // custom parser runs before the route handler, which is what rejects
      // for a missing x-nowpayments-sig header below) — no x-nowpayments-sig
      // header is the actual thing under test here.
      headers: { "content-type": "application/json" },
      payload: raw,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ status: "bad signature" });
  });

  it("happy path: delivers the order and marks it DELIVERED on a finished/paid IPN", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-NPHAPPY", "50");
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-HAPPY-1" });

    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "delivered" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("DELIVERED");

    const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-HAPPY-1" } });
    expect(ledger).not.toBeNull();
    expect(ledger!.outcome).toBe("matched");
  });

  // Task B3a (backend audit): actually_paid/pay_amount are in the PAY
  // currency (whatever coin the buyer chose), while the order total is USDT.
  // Comparing them directly let a coin with a smaller unit value pass the
  // short-payment check while paying a fraction of the price. The value
  // check now runs in the invoice's own price currency.
  describe("amount is verified in the invoice's price currency (Task B3a)", () => {
    async function post(raw: string, signature: string) {
      return app.inject({
        method: "POST",
        url: "/pay/nowpayments/callback",
        headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
        payload: raw,
      });
    }

    it("refuses a pay-currency amount that is numerically above the USD total but short of the quoted pay_amount", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-UNITS", "50");
      // 200 TRX looks like more than 50 — but the quote for $50 was 500 TRX.
      const { raw, signature } = signedIpn({
        orderId: order.orderCode,
        amount: "200",
        payAmount: "500",
        priceAmount: "50",
        payCurrency: "trx",
        trxId: "PID-B3A-UNITS",
      });
      const res = await post(raw, signature);
      expect(res.json()).toEqual({ status: "amount mismatch" });
      expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe("PENDING_PAYMENT");
    });

    it("refuses an invoice priced in a currency other than usd", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-EUR", "50");
      const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", priceCurrency: "eur", trxId: "PID-B3A-EUR" });
      expect((await post(raw, signature)).json()).toEqual({ status: "amount mismatch" });
      expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe("PENDING_PAYMENT");
    });

    it("refuses an IPN with no price_amount — the value cannot be verified", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-NOPRICE", "50");
      const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", priceAmount: null, trxId: "PID-B3A-NOPRICE" });
      expect((await post(raw, signature)).json()).toEqual({ status: "amount mismatch" });
      expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe("PENDING_PAYMENT");
    });

    it("refuses an invoice priced below the order total", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-CHEAP", "50");
      const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "60", payAmount: "60", priceAmount: "5", trxId: "PID-B3A-CHEAP" });
      expect((await post(raw, signature)).json()).toEqual({ status: "amount mismatch" });
    });

    it("delivers when the invoice price is the total rounded down to cents (createInvoice's toFixed(2)), without flagging an overpayment", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-ROUND", "10.004");
      const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "10.00", trxId: "PID-B3A-ROUND" });
      expect((await post(raw, signature)).json()).toEqual({ status: "delivered" });
      const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-B3A-ROUND" } });
      expect(ledger!.outcome).toBe("matched");
    });

    it("delivers when the invoice price is the total rounded up to cents, without flagging an overpayment", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-ROUNDUP", "10.005");
      const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "10.01", trxId: "PID-B3A-ROUNDUP" });
      expect((await post(raw, signature)).json()).toEqual({ status: "delivered" });
      const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-B3A-ROUNDUP" } });
      expect(ledger!.outcome).toBe("matched");
    });

    it("flags an overpayment measured in the price currency", async () => {
      const order = await createPendingNowpaymentsOrder("ORD-NP-B3A-OVER", "50");
      // Quote: 500 TRX for $50; buyer sent 550 TRX = $55.
      const { raw, signature } = signedIpn({
        orderId: order.orderCode,
        amount: "550",
        payAmount: "500",
        priceAmount: "50",
        payCurrency: "trx",
        trxId: "PID-B3A-OVER",
      });
      expect((await post(raw, signature)).json()).toEqual({ status: "delivered" });
      const ledger = await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "PID-B3A-OVER" } });
      expect(ledger!.outcome).toBe("overpaid");
      expect(ledger!.amount!.toString()).toBe("55");
    });
  });

  it("is idempotent: replaying the same payment_id after delivery is a no-op (already_processed)", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-NPREPLAY", "50");
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-REPLAY-1" });

    const first = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: "delivered" });

    const second = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: "already_processed" });
  });

  // M-12 (backend audit 2026-07-31): a signature-valid IPN missing payment_id
  // must be rejected outright (403), never normalized to trxId: "" and
  // ledger-inserted — that empty string would otherwise become a valid
  // idempotency key, and every subsequent broken IPN would be silently
  // answered "already_processed" against that poisoned row, so a
  // genuinely-paid order would never be delivered or flagged. Two identical
  // no-payment_id IPNs are sent below to prove the first didn't leave any
  // poisoned "" claim (or anything else) behind for the second to trip on.
  it("403s on an otherwise-correctly-signed IPN missing payment_id, and independently rejects a second one — no poisoned empty-string ledger state left behind", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-NOPID-NP", "50");
    const raw = JSON.stringify({
      order_id: order.orderCode,
      payment_status: "finished",
      actually_paid: "50",
      pay_amount: "50",
      // payment_id deliberately omitted
    });
    const signature = createHmac("sha512", IPN_SECRET).update(raw).digest("hex");

    const first = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(first.statusCode).toBe(403);
    expect(first.json()).toEqual({ status: "bad signature" });

    const updatedAfterFirst = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updatedAfterFirst!.status).toBe("PENDING_PAYMENT"); // untouched
    expect(await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "" } })).toBeNull();

    const second = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toEqual({ status: "bad signature" });

    const updatedAfterSecond = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updatedAfterSecond!.status).toBe("PENDING_PAYMENT"); // still untouched — second IPN independently rejected
    expect(await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "" } })).toBeNull();
  });

  // Same M-12 gap, but via a literal "" payment_id rather than an omitted one
  // — "" passes a naive `typeof x === "string"` check, so this is a distinct
  // code path from the missing-payment_id case above and must be rejected
  // explicitly too. Two identical empty-string IPNs are sent to prove the
  // first didn't leave a poisoned "" ledger row for the second to trip on.
  it("403s on an otherwise-correctly-signed IPN with a literal empty-string payment_id, and independently rejects a second one — no poisoned empty-string ledger state left behind", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-EMPTYPID-NP", "50");
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "" });

    const first = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(first.statusCode).toBe(403);
    expect(first.json()).toEqual({ status: "bad signature" });

    const updatedAfterFirst = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updatedAfterFirst!.status).toBe("PENDING_PAYMENT"); // untouched
    expect(await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "" } })).toBeNull();

    const second = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(second.statusCode).toBe(403);
    expect(second.json()).toEqual({ status: "bad signature" });

    const updatedAfterSecond = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updatedAfterSecond!.status).toBe("PENDING_PAYMENT"); // still untouched — second IPN independently rejected
    expect(await prisma.processedNowpaymentsTx.findUnique({ where: { trxId: "" } })).toBeNull();
  });

  it("records an unmatched tx when no NOWPAYMENTS order matches the order_id", async () => {
    const { raw, signature } = signedIpn({ orderId: "ORD-NO-SUCH-ORDER", amount: "12.5", trxId: "PID-UNMATCHED-1" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
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
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50000", trxId: "PID-WRONGMETHOD-1" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
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
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50000", trxId: "PID-WRONGCURR-1" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "unmatched" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT"); // untouched
  });

  it("never delivers a short/underpaid amount — records unmatched instead", async () => {
    const order = await createPendingNowpaymentsOrder("ORD-SHORTPAY-NP", "50");
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "40", trxId: "PID-SHORT-1" }); // less than totalAmount
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
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
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-PENDING-1", status: "waiting" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
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
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "49.99", trxId: "PID-PARTIAL-1", status: "partially_paid" });
    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ignored" });

    const updated = await prisma.order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PENDING_PAYMENT");
  });

  // M-10 (backend audit 2026-07-31): the order left PENDING_PAYMENT (here,
  // simulating autoCancelExpiredOrders having already cancelled it) between
  // this IPN arriving and deliverPaidNowpaymentsOrder's transaction running.
  // No poller can recover this either, so it must alert an admin rather than
  // silently doing nothing.
  it("logs a warning and enqueues an ADMIN_STALE_PAYMENT alert when the order left PENDING_PAYMENT before delivery ran", async () => {
    const order = await prisma.order.create({
      data: {
        orderCode: "ORD-NPSTALE",
        userId,
        subtotalAmount: "50",
        totalAmount: "50",
        status: "CANCELLED", // no longer PENDING_PAYMENT by the time the IPN's delivery transaction runs
        currency: "USDT",
        paymentMethod: "NOWPAYMENTS",
      },
    });
    const { raw, signature } = signedIpn({ orderId: order.orderCode, amount: "50", trxId: "PID-STALE-1" });

    const res = await app.inject({
      method: "POST",
      url: "/pay/nowpayments/callback",
      headers: { "content-type": "application/json", "x-nowpayments-sig": signature },
      payload: raw,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "stale" });

    const rows = await prisma.notificationOutbox.findMany({
      where: { event: "ADMIN_STALE_PAYMENT", orderId: order.id },
    });
    expect(rows.length).toBeGreaterThan(0);
    const alert = JSON.parse(rows[0]!.payloadJson) as { order_code: string; gateway: string; trx_id: string };
    expect(alert.order_code).toBe("ORD-NPSTALE");
    expect(alert.gateway).toBe("NOWPayments");
    expect(alert.trx_id).toBe("PID-STALE-1");
  });
});
