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

/** A buyer + a PENDING_PAYMENT PayDisini order, created directly (payView's
 * lazy-invoice branch only reads the order row — no cart/stock needed). */
async function makeBuyerWithOrder() {
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
      subtotalAmount: "10000",
      totalAmount: "10000",
      status: "PENDING_PAYMENT",
      currency: "IDR",
      paymentMethod: "PAYDISINI",
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
