// Route-level regression test for the checkout gateway-invoice race (Data-2
// fix, backend audit 2026-07-07): apps/storefront/src/routes/checkout.ts's
// payView lazily creates a gateway transaction/invoice (TokoPay/PayDisini/
// NOWPayments) and caches it into order.paymentRef on the FIRST page load.
// Two concurrent GET /api/v1/orders/:code/pay requests for the SAME order
// (e.g. a pay-page double-load) used to each see no cached ref and each
// create a separate gateway transaction. The fix adds an atomic claim
// (claimGatewaySlot) before the external call, so only the winner ever calls
// the gateway; the loser gets the same "contact us" fallback UI a gateway
// failure already shows (no polling/retry loop). PayDisini is used here as
// the representative gateway — all three lazy-invoice blocks in checkout.ts
// share the exact same claim/commit/release shape.
import "./setup-env"; // FIRST import — sets env before @app/* load
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateTransaction = vi.fn();
vi.mock("@app/core/payments/paydisini", async () => {
  const actual = await vi.importActual<typeof import("@app/core/payments/paydisini")>("@app/core/payments/paydisini");
  return { ...actual, createTransaction: (...args: unknown[]) => mockCreateTransaction(...args) };
});
const mockCreateTokopayTransaction = vi.fn();
vi.mock("@app/core/payments/tokopay", async () => {
  const actual = await vi.importActual<typeof import("@app/core/payments/tokopay")>("@app/core/payments/tokopay");
  return { ...actual, createTransaction: (...args: unknown[]) => mockCreateTokopayTransaction(...args) };
});

import type { FastifyInstance } from "fastify";
import { cleanupTestDb } from "./setup-env";
import { prisma, initDb, setSetting } from "@app/db";
import { hashPassword } from "@app/core/password";
import { buildApp } from "../src/server";

let app: FastifyInstance;
let userSeq = 0;

async function loginAs(identifier: string, password: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifier, password } });
  expect(res.statusCode).toBe(200);
  const c = res.headers["set-cookie"];
  return Array.isArray(c) ? c.join("; ") : String(c);
}

/** A buyer + a PENDING_PAYMENT order (PayDisini unless told otherwise),
 * created directly (payView's lazy-invoice branch only reads the order row —
 * no cart/stock needed). */
async function makeBuyerWithOrder(opts: { paymentMethod?: "PAYDISINI" | "TOKOPAY"; totalAmount?: string } = {}) {
  const totalAmount = opts.totalAmount ?? "10000";
  userSeq += 1;
  const username = `racer${userSeq}`;
  const password = "race-pw-12345";
  const user = await prisma.user.create({
    data: {
      loginUsername: username,
      email: `${username}@u.test`,
      passwordHash: hashPassword(password),
      referralCode: `RACEREF${userSeq}`,
    },
  });
  const cookie = await loginAs(username, password);
  const order = await prisma.order.create({
    data: {
      orderCode: `ORD-RACE-${userSeq}`,
      userId: user.id,
      subtotalAmount: totalAmount,
      totalAmount,
      status: "PENDING_PAYMENT",
      currency: "IDR",
      paymentMethod: opts.paymentMethod ?? "PAYDISINI",
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
  });
  return { order, cookie };
}

beforeAll(async () => {
  await initDb();
  app = await buildApp();
  await setSetting(prisma, "setup_completed", "true");
  await setSetting(prisma, "shop_name", "Race Test Shop");
  await setSetting(prisma, "paydisini_userkey", "uk-test");
  await setSetting(prisma, "paydisini_apikey", "ak-test");
  await setSetting(prisma, "paydisini_default_channel", "QRIS");
  await setSetting(prisma, "tokopay_merchant_id", "m-test-tokopay");
  await setSetting(prisma, "tokopay_secret", "s-test-tokopay");
  await setSetting(prisma, "tokopay_default_channel", "QRIS");
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  cleanupTestDb();
});

describe("checkout gateway-invoice race (Data-2)", () => {
  beforeEach(() => {
    mockCreateTransaction.mockReset();
  });

  it("two concurrent GET pay requests for the same order call the gateway exactly once", async () => {
    let resolveGateway!: (v: unknown) => void;
    mockCreateTransaction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGateway = resolve;
        }),
    );

    const { order, cookie } = await makeBuyerWithOrder();

    const req1 = app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    const req2 = app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });

    // Poll (rather than a fixed sleep, which would be flaky under DB/CI
    // jitter) until the winner's claim has gone through and it has actually
    // called the gateway — only then resolve it, so the LOSER's own claim
    // attempt genuinely finds the sentinel already in place instead of racing
    // against real wall-clock timing.
    while (mockCreateTransaction.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    resolveGateway({
      trxId: "PD-RACE",
      qrString: "000",
      qrUrl: "https://x/paydisini-qr.png",
      checkoutUrl: "https://x/paydisini-checkout",
      totalBayar: "10000",
    });

    const [res1, res2] = await Promise.all([req1, req2]);
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(mockCreateTransaction).toHaveBeenCalledTimes(1);

    const bodies = [res1.json(), res2.json()];
    const winner = bodies.find((b) => b.paydisini_gateway !== null);
    const loser = bodies.find((b) => b.paydisini_gateway === null);
    expect(winner).toBeTruthy();
    expect(winner!.paydisini_gateway).toMatchObject({ trxId: "PD-RACE" });
    expect(winner!.paydisini_gateway_error).toBe(false);
    // The loser falls back to the SAME "contact us" UI a gateway failure
    // already shows — no polling/retry loop.
    expect(loser).toBeTruthy();
    expect(loser!.paydisini_gateway_error).toBe(true);

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(JSON.parse(persisted!.paymentRef!)).toMatchObject({ gateway: "paydisini", trxId: "PD-RACE" });
  });

  it("releases the claim on gateway failure so a later request can retry and succeed", async () => {
    const { order, cookie } = await makeBuyerWithOrder();

    mockCreateTransaction.mockRejectedValueOnce(new Error("gateway down"));
    const failed = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(failed.statusCode).toBe(200);
    expect(failed.json().paydisini_gateway_error).toBe(true);

    const afterFailure = await prisma.order.findUnique({ where: { id: order.id } });
    expect(afterFailure!.paymentRef).toBeNull(); // claim released, not left dangling forever

    mockCreateTransaction.mockResolvedValueOnce({
      trxId: "PD-RETRY",
      qrString: "000",
      qrUrl: "https://x/paydisini-qr.png",
      checkoutUrl: "https://x/paydisini-checkout",
      totalBayar: "10000",
    });
    const retried = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().paydisini_gateway_error).toBe(false);
    expect(retried.json().paydisini_gateway).toMatchObject({ trxId: "PD-RETRY" });
  });
});

// The TokoPay pay page shows TokoPay's own fee-inclusive total, stored on the
// order when the transaction is created; there is no fee formula to fall back
// on, so a transaction without a usable total is never shown.
describe("TokoPay pay page shows TokoPay's own total", () => {
  beforeEach(() => {
    mockCreateTokopayTransaction.mockReset();
  });

  function tokopayTransaction(trxId: string, totalBayar: string | null) {
    return {
      trxId,
      payUrl: "https://x/tokopay-pay",
      qrLink: "https://x/tokopay-qr.png",
      qrString: "000201",
      totalBayar,
    };
  }

  it("returns TokoPay's total and the fee derived from it, and stores the total on the order", async () => {
    mockCreateTokopayTransaction.mockResolvedValueOnce(tokopayTransaction("TP-PAYVIEW-1", "50025"));
    const { order, cookie } = await makeBuyerWithOrder({ paymentMethod: "TOKOPAY", totalAmount: "50000" });

    const res = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gateway_error).toBe(false);
    expect(body.gateway).toMatchObject({ trxId: "TP-PAYVIEW-1" });
    expect(body.order.qris_grand_total).toBe("50025");
    expect(body.order.qris_admin_fee).toBe("25");

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted!.gatewayChargeAmount!.toString()).toBe("50025");
  });

  it("reads the cached transaction and stored total on a second visit without creating another transaction", async () => {
    mockCreateTokopayTransaction.mockResolvedValueOnce(tokopayTransaction("TP-PAYVIEW-2", "50025"));
    const { order, cookie } = await makeBuyerWithOrder({ paymentMethod: "TOKOPAY", totalAmount: "50000" });

    const first = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(first.json().order.qris_grand_total).toBe("50025");

    const second = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(second.statusCode).toBe(200);
    expect(mockCreateTokopayTransaction).toHaveBeenCalledTimes(1);
    expect(second.json().gateway).toMatchObject({ trxId: "TP-PAYVIEW-2" });
    expect(second.json().order.qris_grand_total).toBe("50025");
    expect(second.json().order.qris_admin_fee).toBe("25");
  });

  it("shows the gateway-error fallback and stores nothing when TokoPay reports no total", async () => {
    mockCreateTokopayTransaction.mockResolvedValueOnce(tokopayTransaction("TP-PAYVIEW-NULL", null));
    const { order, cookie } = await makeBuyerWithOrder({ paymentMethod: "TOKOPAY", totalAmount: "50000" });

    const res = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gateway_error).toBe(true);
    expect(body.gateway).toBeNull();
    expect(body.order.qris_grand_total).toBeNull();
    expect(body.order.qris_admin_fee).toBeNull();

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted!.gatewayChargeAmount).toBeNull();
    expect(persisted!.paymentRef).toBeNull(); // slot released for a retry
  });

  it("shows the gateway-error fallback and stores nothing when TokoPay reports a total below the order total", async () => {
    mockCreateTokopayTransaction.mockResolvedValueOnce(tokopayTransaction("TP-PAYVIEW-3", "49000"));
    const { order, cookie } = await makeBuyerWithOrder({ paymentMethod: "TOKOPAY", totalAmount: "50000" });

    const res = await app.inject({ method: "GET", url: `/api/v1/orders/${order.orderCode}/pay`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gateway_error).toBe(true);
    expect(body.gateway).toBeNull();
    expect(body.order.qris_grand_total).toBeNull();
    expect(body.order.qris_admin_fee).toBeNull();

    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    expect(persisted!.gatewayChargeAmount).toBeNull();
    expect(persisted!.paymentRef).toBeNull(); // slot released for a retry
  });
});
