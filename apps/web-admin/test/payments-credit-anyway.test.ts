/**
 * Task 3: POST /api/payments/order/:orderId/credit-anyway — the "Credit to
 * balance anyway" admin action for an UNDERPAID WALLET_TOPUP order. Cancels
 * the order and credits the buyer's wallet with exactly what they actually
 * sent (not the amount they originally asked to top up), same shape as the
 * sibling `/refund` route (payments-refund-idempotency.test.ts), including
 * Idempotency-Key replay for a double-clicked button.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { Decimal } from "@app/core/money";
import { PaymentMethod } from "@app/core/enums";
import { prisma, initDb, setSetting, markUnderpaid, createOrderDirect, createWalletTopupOrder } from "@app/db";
import { resetDb, buildSampleData, type SampleData } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let sample: SampleData;

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
  sample = await buildSampleData(prisma);
  const admin = await prisma.user.create({ data: { telegramId: ADMIN_TG, username: "admin", fullName: "Admin", role: "ADMIN", referralCode: `a${Math.random()}` } });
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

/** An UNDERPAID WALLET_TOPUP order — a top-up order flagged underpaid with a
 * `processedBinanceTx` row recording what actually arrived, same as a real
 * Binance-internal-transfer shortfall would. creditUnderpaidTopupAnyway only
 * accepts orders in this state and kind. */
async function makeUnderpaidTopupOrder(txId: string, received = "6.5") {
  const order = await prisma.$transaction((tx) =>
    createWalletTopupOrder(tx, { userId: sample.user.id, amount: "10", currency: "USDT", method: PaymentMethod.BINANCE_INTERNAL, rate: "16000" }),
  );
  const flagged = await markUnderpaid(prisma, { orderId: order.id, binanceTxId: txId, amount: received });
  expect(flagged).toBe(true);
  return order;
}

/** A PRODUCT-kind UNDERPAID order — creditUnderpaidTopupAnyway must refuse
 * these with `error.order_not_wallet_topup`. */
async function makeUnderpaidProductOrder(txId: string) {
  const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  const flagged = await markUnderpaid(prisma, { orderId: order.id, binanceTxId: txId, amount: "1.00" });
  expect(flagged).toBe(true);
  return order;
}

function creditAnyway(orderId: number, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/payments/order/${orderId}/credit-anyway`,
    headers: { "x-csrf-token": csrf, ...headers },
    cookies: { [COOKIE]: cookie },
  });
}

describe("POST /api/payments/order/:orderId/credit-anyway", () => {
  it("credits the amount actually received, cancels the order, and logs the admin action", async () => {
    const order = await makeUnderpaidTopupOrder("tx-credit-anyway-happy", "6.5");
    const buyerBefore = new Decimal((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalanceUsdt);

    const res = await creditAnyway(order.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const resolved = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(resolved.status).toBe("CANCELLED");

    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const buyerAfter = new Decimal(buyer.walletBalanceUsdt);
    expect(buyerAfter.minus(buyerBefore).toString()).toBe("6.5");

    const audit = await prisma.auditLog.findMany({ where: { action: "underpaid_topup_credit_anyway", targetId: order.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toContain("6.5");
  });

  it("refuses a PRODUCT-kind underpaid order with 422 error.order_not_wallet_topup", async () => {
    const order = await makeUnderpaidProductOrder("tx-credit-anyway-product");

    const res = await creditAnyway(order.id);

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "error.order_not_wallet_topup" });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("UNDERPAID");
  });

  describe("Idempotency-Key", () => {
    it("replays the exact success response for a repeated request with the same key, crediting only once", async () => {
      const order = await makeUnderpaidTopupOrder("tx-credit-anyway-replay", "6.5");
      const key = "credit-anyway-key-1";

      const first = await creditAnyway(order.id, { "idempotency-key": key });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true });

      const second = await creditAnyway(order.id, { "idempotency-key": key });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ok: true });

      // Credited exactly once — the buyer's wallet only moved on the first
      // attempt, and the audit log only recorded one credit-anyway action.
      const walletTx = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "admin_adjust" } });
      expect(walletTx).toHaveLength(1);
      const auditRows = await prisma.auditLog.findMany({ where: { action: "underpaid_topup_credit_anyway", targetId: order.id } });
      expect(auditRows).toHaveLength(1);
    });

    it("with no header: two credit-anyway attempts on the same order behave as before (first succeeds, second 422s)", async () => {
      const order = await makeUnderpaidTopupOrder("tx-credit-anyway-no-header", "6.5");

      const first = await creditAnyway(order.id);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ ok: true });

      const second = await creditAnyway(order.id);
      expect(second.statusCode).toBe(422);
    });
  });
});
