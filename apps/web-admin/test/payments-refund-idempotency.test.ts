/**
 * Task 1: Idempotency-Key on POST /api/payments/order/:orderId/refund — a
 * double-clicked "Refund" button (or a retried request after the admin's
 * browser never saw the first response) must replay the exact first
 * response instead of hitting refundUnderpaidOrder's own state guard (which
 * would otherwise show a confusing 422 "order not underpaid" on the retry,
 * even though the refund already happened).
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { prisma, initDb, setSetting, markUnderpaid, createOrderDirect } from "@app/db";
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

/** An UNDERPAID order — a PENDING_PAYMENT order (createOrderDirect) flagged
 * underpaid (markUnderpaid), same as a real Binance-internal-transfer
 * shortfall would. refundUnderpaidOrder only accepts orders in this state. */
async function makeUnderpaidOrder(txId: string) {
  const order = (await createOrderDirect(prisma, { user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  const flagged = await markUnderpaid(prisma, { orderId: order.id, binanceTxId: txId, amount: "1.00" });
  expect(flagged).toBe(true);
  return order;
}

function refund(orderId: number, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/payments/order/${orderId}/refund`,
    headers: { "x-csrf-token": csrf, ...headers },
    cookies: { [COOKIE]: cookie },
  });
}

describe("POST /api/payments/order/:orderId/refund — Idempotency-Key", () => {
  it("with no header: two refund attempts on the same order behave as before (first succeeds, second 422s)", async () => {
    const order = await makeUnderpaidOrder("tx-no-header");

    const first = await refund(order.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await refund(order.id);
    expect(second.statusCode).toBe(422);
  });

  it("replays the exact success response for a repeated request with the same key, refunding only once", async () => {
    const order = await makeUnderpaidOrder("tx-replay-success");
    const key = "refund-key-1";

    const first = await refund(order.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await refund(order.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });

    // Refunded exactly once — the buyer's wallet only got credited on the
    // first attempt, and the audit log only recorded one refund action.
    const walletTx = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } });
    expect(walletTx).toHaveLength(1);
    const auditRows = await prisma.auditLog.findMany({ where: { action: "underpaid_refund", targetId: order.id } });
    expect(auditRows).toHaveLength(1);
  });

  it("replays a stored 422 the same way — a retry doesn't re-attempt a refund the order can no longer accept", async () => {
    const order = await makeUnderpaidOrder("tx-replay-422");
    // Move the order out of UNDERPAID first (no idempotency key), so the
    // NEXT call fails at refundUnderpaidOrder's own state guard.
    const preRefund = await refund(order.id);
    expect(preRefund.statusCode).toBe(200);

    const key = "refund-key-422";
    const first = await refund(order.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(422);
    const firstBody = first.json();

    const second = await refund(order.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(422);
    expect(second.json()).toEqual(firstBody);
  });

  it("409s when the same key is reused for a DIFFERENT order (different request hash)", async () => {
    const orderA = await makeUnderpaidOrder("tx-conflict-a");
    const orderB = await makeUnderpaidOrder("tx-conflict-b");
    const key = "refund-key-conflict";

    const first = await refund(orderA.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);

    const second = await refund(orderB.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "idempotency_key_reused" });

    // orderB must NOT have been refunded — the conflict short-circuited before refundUnderpaidOrder ran.
    const orderBRow = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(orderBRow!.status).toBe("UNDERPAID");
  });
});
