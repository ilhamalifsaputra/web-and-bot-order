/**
 * Task 4: Idempotency-Key on the 5 admin payments mutations that sit
 * alongside `refund` (payments-refund-idempotency.test.ts) in
 * apps/web-admin/src/routes/api/payments.ts — deliver, cancel, match,
 * credit, dismiss. Same problem as refund: a double-clicked button (or a
 * retried request after the admin's browser never saw the first response)
 * must replay the exact first response instead of re-running the mutation
 * and hitting its own state guard on the second attempt.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  initDb,
  setSetting,
  markUnderpaid,
  createOrderDirect,
  createInternalOrder,
  createWalletTopupOrder,
  recordUnmatchedTx,
  recordUnmatchedTokopayTx,
  recordUnmatchedNowpaymentsTx,
  triggerDigiflazzDispatch,
  logAdminAction,
} from "@app/db";
import { logger } from "@app/core/logger";
import { PaymentMethod } from "@app/core/enums";
import { qrisChargeAmount } from "@app/core/payments/tokopay";
import { routeOrderToDigiflazz } from "../../../tests/helpers/digiflazzRouting";

// The instant Digiflazz dispatch is observed, not run: the manual-match test
// checks that it is started for a PROCESSING settlement, not what Digiflazz answers.
// `logAdminAction` passes through to the real one; a test makes it fail once
// to check a match that committed still answers success.
vi.mock("@app/db", async (orig) => {
  const actual = await orig<typeof import("@app/db")>();
  return {
    ...actual,
    triggerDigiflazzDispatch: vi.fn(),
    logAdminAction: vi.fn((...a: Parameters<typeof actual.logAdminAction>) => actual.logAdminAction(...a)),
  };
});
import { resetDb, buildSampleData, type SampleData } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let sample: SampleData;
let adminUserId: number;

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
  adminUserId = admin.id;
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
  vi.mocked(triggerDigiflazzDispatch).mockReset();
});

/** An UNDERPAID order — a PENDING_PAYMENT order (createOrderDirect) flagged
 * underpaid (markUnderpaid), same as a real Binance-internal-transfer
 * shortfall would. deliverUnderpaidOrder/cancelOrder exercise it here. */
async function makeUnderpaidOrder(txId: string) {
  const order = (await createOrderDirect(prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
  const flagged = await markUnderpaid(prisma, { orderId: order.id, binanceTxId: txId, amount: "1.00" });
  expect(flagged).toBe(true);
  return order;
}

/** A PENDING_PAYMENT order paired with an UNMATCHED ProcessedBinanceTx row —
 * the fixture manualMatchTx/creditOrderToBalance both need. */
async function makePendingOrder() {
  return (await createOrderDirect(prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
}

/** A PENDING_PAYMENT USDT order — credit-to-balance only accepts a Binance
 * transfer (always USDT) onto a USDT order. */
async function makePendingUsdtOrder() {
  return (await prisma.$transaction((tx) =>
    createInternalOrder(tx, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1, rate: 1 }),
  ))!;
}

function deliver(orderId: number, headers: Record<string, string> = {}, reason: unknown = "Approved shortfall") {
  return app.inject({
    method: "POST",
    url: `/api/payments/order/${orderId}/deliver`,
    payload: { reason },
    headers: { "x-csrf-token": csrf, ...headers },
    cookies: { [COOKIE]: cookie },
  });
}

function cancel(orderId: number, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: `/api/payments/order/${orderId}/cancel`,
    headers: { "x-csrf-token": csrf, ...headers },
    cookies: { [COOKIE]: cookie },
  });
}

function match(binanceTxId: string, orderCode: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/payments/match",
    headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded", ...headers },
    cookies: { [COOKIE]: cookie },
    payload: new URLSearchParams({ binance_tx_id: binanceTxId, order_code: orderCode }).toString(),
  });
}

function credit(binanceTxId: string, orderCode: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/payments/credit",
    headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded", ...headers },
    cookies: { [COOKIE]: cookie },
    payload: new URLSearchParams({ binance_tx_id: binanceTxId, order_code: orderCode }).toString(),
  });
}

function dismiss(binanceTxId: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/payments/dismiss",
    headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded", ...headers },
    cookies: { [COOKIE]: cookie },
    payload: new URLSearchParams({ binance_tx_id: binanceTxId }).toString(),
  });
}

describe("POST /api/payments/order/:orderId/deliver — Idempotency-Key", () => {
  it("rejects an override without a reason before changing the order", async () => {
    const order = await makeUnderpaidOrder("dtx-no-reason");
    const response = await deliver(order.id, {}, " ");
    expect(response.statusCode).toBe(400);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("UNDERPAID");
    expect(await prisma.auditLog.count({ where: { targetId: order.id, action: "underpaid_deliver" } })).toBe(0);
  });

  it("binds the idempotency key to the supplied override reason", async () => {
    const order = await makeUnderpaidOrder("dtx-reason-hash");
    expect((await deliver(order.id, { "idempotency-key": "reason-bound" }, "Goodwill exception")).statusCode).toBe(200);
    expect((await deliver(order.id, { "idempotency-key": "reason-bound" }, "A different explanation")).statusCode).toBe(409);
  });
  it("with no header: two deliver attempts on the same order behave as before (first succeeds, second 422s)", async () => {
    const order = await makeUnderpaidOrder("dtx-no-header");

    const first = await deliver(order.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await deliver(order.id);
    expect(second.statusCode).toBe(422);
  });

  it("replays the exact success response for a repeated request with the same key, delivering only once", async () => {
    const order = await makeUnderpaidOrder("dtx-replay-success");
    const key = "deliver-key-1";

    const first = await deliver(order.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await deliver(order.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "underpaid_deliver", targetId: order.id } });
    expect(auditRows).toHaveLength(1);
    // The replay queues no second credentials DM.
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: "ORDER_DELIVERED_DM" } })).toBe(1);
  });

  it("replays a stored 422 the same way — a retry doesn't re-attempt a delivery the order can no longer accept", async () => {
    const order = await makeUnderpaidOrder("dtx-replay-422");
    // Move the order out of UNDERPAID first (no idempotency key), so the
    // NEXT call fails at deliverUnderpaidOrder's own state guard.
    const preDeliver = await deliver(order.id);
    expect(preDeliver.statusCode).toBe(200);

    const key = "deliver-key-422";
    const first = await deliver(order.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(422);
    const firstBody = first.json();

    const second = await deliver(order.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(422);
    expect(second.json()).toEqual(firstBody);
  });

  it("409s when the same key is reused for a DIFFERENT order (different request hash)", async () => {
    const orderA = await makeUnderpaidOrder("dtx-conflict-a");
    const orderB = await makeUnderpaidOrder("dtx-conflict-b");
    const key = "deliver-key-conflict";

    const first = await deliver(orderA.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);

    const second = await deliver(orderB.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "idempotency_key_reused" });

    const orderBRow = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(orderBRow!.status).toBe("UNDERPAID");
  });
});

describe("POST /api/payments/order/:orderId/cancel — Idempotency-Key", () => {
  it("with no header: two cancel attempts on the same order behave as before (both succeed — cancelOrder is a no-op on an already-cancelled order)", async () => {
    const order = await makeUnderpaidOrder("ctx-no-header");

    const first = await cancel(order.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await cancel(order.id);
    expect(second.statusCode).toBe(200);
  });

  it("replays the exact success response for a repeated request with the same key, cancelling only once", async () => {
    const order = await makeUnderpaidOrder("ctx-replay-success");
    const key = "cancel-key-1";

    const first = await cancel(order.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await cancel(order.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "underpaid_cancel", targetId: order.id } });
    expect(auditRows).toHaveLength(1);
    expect((await prisma.order.findUnique({ where: { id: order.id } }))!.status).toBe("CANCELLED");
  });

  it("replays a stored 422 the same way — a retry doesn't re-attempt a cancel that can't happen", async () => {
    const missingOrderId = 999_999;
    const key = "cancel-key-422";

    const first = await cancel(missingOrderId, { "idempotency-key": key });
    expect(first.statusCode).toBe(422);
    const firstBody = first.json();

    const second = await cancel(missingOrderId, { "idempotency-key": key });
    expect(second.statusCode).toBe(422);
    expect(second.json()).toEqual(firstBody);
  });

  it("409s when the same key is reused for a DIFFERENT order (different request hash)", async () => {
    const orderA = await makeUnderpaidOrder("ctx-conflict-a");
    const orderB = await makeUnderpaidOrder("ctx-conflict-b");
    const key = "cancel-key-conflict";

    const first = await cancel(orderA.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);

    const second = await cancel(orderB.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "idempotency_key_reused" });

    const orderBRow = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(orderBRow!.status).toBe("UNDERPAID");
  });
});

describe("POST /api/payments/match — Idempotency-Key", () => {
  it("with no header: two match attempts on the same transfer behave as before (first succeeds, second 422s)", async () => {
    const order = await makePendingOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "mtx-no-header", amount: "1.00" });

    const first = await match("mtx-no-header", order.orderCode);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await match("mtx-no-header", order.orderCode);
    expect(second.statusCode).toBe(422);
    // Delivered from stock: nothing for Digiflazz to do.
    expect(triggerDigiflazzDispatch).not.toHaveBeenCalled();
  });

  it("starts the instant Digiflazz dispatch exactly once when a match settles a Digiflazz order into PROCESSING", async () => {
    const order = await makePendingOrder();
    await routeOrderToDigiflazz(prisma, order.id);
    await recordUnmatchedTx(prisma, { binanceTxId: "mtx-digiflazz", amount: "1.00" });

    const res = await match("mtx-digiflazz", order.orderCode);
    expect(res.statusCode).toBe(200);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PROCESSING");
    expect(triggerDigiflazzDispatch).toHaveBeenCalledTimes(1);
    expect(triggerDigiflazzDispatch).toHaveBeenCalledWith(order.id);
  });

  it("replays the exact success response for a repeated request with the same key, matching only once", async () => {
    const order = await makePendingOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "mtx-replay-success", amount: "1.00" });
    const key = "match-key-1";

    const first = await match("mtx-replay-success", order.orderCode, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await match("mtx-replay-success", order.orderCode, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "tx_manual_match", targetId: order.id } });
    expect(auditRows).toHaveLength(1);
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "mtx-replay-success" } });
    expect(tx!.outcome).toBe("matched");
    // The replay queues no second credentials DM.
    expect(await prisma.notificationOutbox.count({ where: { orderId: order.id, event: "ORDER_DELIVERED_DM" } })).toBe(1);
  });

  it("replays a stored 400 the same way — a repeated invalid request doesn't re-validate every time", async () => {
    const key = "match-key-400";

    const first = await match("", "", { "idempotency-key": key });
    expect(first.statusCode).toBe(400);
    const firstBody = first.json();

    const second = await match("", "", { "idempotency-key": key });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual(firstBody);
  });

  it("409s when the same key is reused for a DIFFERENT match request (different request hash)", async () => {
    const orderA = await makePendingOrder();
    const orderB = await makePendingOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "mtx-conflict-a", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "mtx-conflict-b", amount: "1.00" });
    const key = "match-key-conflict";

    const first = await match("mtx-conflict-a", orderA.orderCode, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);

    const second = await match("mtx-conflict-b", orderB.orderCode, { "idempotency-key": key });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "idempotency_key_reused" });

    const txB = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "mtx-conflict-b" } });
    expect(txB!.outcome).toBe("unmatched");
  });
});

describe("POST /api/payments/credit — Idempotency-Key", () => {
  it("with no header: two credit attempts on the same transfer behave as before (first succeeds, second 422s)", async () => {
    const order = await makePendingUsdtOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "crtx-no-header", amount: "1.00" });

    const first = await credit("crtx-no-header", order.orderCode);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await credit("crtx-no-header", order.orderCode);
    expect(second.statusCode).toBe(422);
  });

  it("replays the exact success response for a repeated request with the same key, crediting only once", async () => {
    const order = await makePendingUsdtOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "crtx-replay-success", amount: "1.00" });
    const key = "credit-key-1";

    const first = await credit("crtx-replay-success", order.orderCode, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await credit("crtx-replay-success", order.orderCode, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "tx_credit_balance", targetId: order.id } });
    expect(auditRows).toHaveLength(1);
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "crtx-replay-success" } });
    expect(tx!.outcome).toBe("credited_to_balance");
  });

  it("replays a stored 400 the same way — a repeated invalid request doesn't re-validate every time", async () => {
    const key = "credit-key-400";

    const first = await credit("", "", { "idempotency-key": key });
    expect(first.statusCode).toBe(400);
    const firstBody = first.json();

    const second = await credit("", "", { "idempotency-key": key });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual(firstBody);
  });

  it("409s when the same key is reused for a DIFFERENT credit request (different request hash)", async () => {
    const orderA = await makePendingUsdtOrder();
    const orderB = await makePendingUsdtOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "crtx-conflict-a", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "crtx-conflict-b", amount: "1.00" });
    const key = "credit-key-conflict";

    const first = await credit("crtx-conflict-a", orderA.orderCode, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);

    const second = await credit("crtx-conflict-b", orderB.orderCode, { "idempotency-key": key });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "idempotency_key_reused" });

    const txB = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "crtx-conflict-b" } });
    expect(txB!.outcome).toBe("unmatched");
  });
});

describe("POST /api/payments/dismiss — Idempotency-Key", () => {
  it("with no header: two dismiss attempts on the same transfer behave as before (first succeeds, second 422s)", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "dstx-no-header", amount: "1.00" });

    const first = await dismiss("dstx-no-header");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await dismiss("dstx-no-header");
    expect(second.statusCode).toBe(422);
  });

  it("replays the exact success response for a repeated request with the same key, dismissing only once", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "dstx-replay-success", amount: "1.00" });
    const key = "dismiss-key-1";

    const first = await dismiss("dstx-replay-success", { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true });

    const second = await dismiss("dstx-replay-success", { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });

    const auditRows = await prisma.auditLog.findMany({ where: { action: "tx_dismiss" } });
    expect(auditRows).toHaveLength(1);
    const tx = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "dstx-replay-success" } });
    expect(tx!.outcome).toBe("dismissed");
  });

  it("replays a stored 400 the same way — a repeated invalid request doesn't re-validate every time", async () => {
    const key = "dismiss-key-400";

    const first = await dismiss("", { "idempotency-key": key });
    expect(first.statusCode).toBe(400);
    const firstBody = first.json();

    const second = await dismiss("", { "idempotency-key": key });
    expect(second.statusCode).toBe(400);
    expect(second.json()).toEqual(firstBody);
  });

  it("409s when the same key is reused for a DIFFERENT transfer (different request hash)", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "dstx-conflict-a", amount: "1.00" });
    await recordUnmatchedTx(prisma, { binanceTxId: "dstx-conflict-b", amount: "1.00" });
    const key = "dismiss-key-conflict";

    const first = await dismiss("dstx-conflict-a", { "idempotency-key": key });
    expect(first.statusCode).toBe(200);

    const second = await dismiss("dstx-conflict-b", { "idempotency-key": key });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "idempotency_key_reused" });

    const txB = await prisma.processedBinanceTx.findUnique({ where: { binanceTxId: "dstx-conflict-b" } });
    expect(txB!.outcome).toBe("unmatched");
  });
});

// Manual match / dismiss on every gateway (crud/manualMatch.ts). The route
// takes an optional `gateway` beside the transfer reference; without one the
// crud resolves the reference across all five ledgers, so old Binance-only
// clients keep working.
describe("POST /api/payments/match and /dismiss — every gateway", () => {
  function matchWith(body: Record<string, string>, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/payments/match",
      headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded", ...headers },
      cookies: { [COOKIE]: cookie },
      payload: new URLSearchParams(body).toString(),
    });
  }

  function dismissWith(body: Record<string, string>, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/payments/dismiss",
      headers: { "x-csrf-token": csrf, "content-type": "application/x-www-form-urlencoded", ...headers },
      cookies: { [COOKIE]: cookie },
      payload: new URLSearchParams(body).toString(),
    });
  }

  async function makePendingTokopayOrder() {
    const order = (await createOrderDirect(prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    return prisma.order.update({ where: { id: order.id }, data: { paymentMethod: PaymentMethod.TOKOPAY, currency: "IDR" } });
  }

  it("matches an unmatched TokoPay row named by gateway, settles the order and audits the gateway by name", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-1", amount: qrisChargeAmount(order.totalAmount) });

    const res = await matchWith({ binance_tx_id: "tp-route-1", order_code: order.orderCode, gateway: "tokopay" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const row = await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-route-1" } });
    expect(row.outcome).toBe("matched");
    expect(row.orderId).toBe(order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DELIVERED");

    const audit = await prisma.auditLog.findMany({ where: { action: "tx_manual_match", targetId: order.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminId).toBe(adminUserId);
    expect(audit[0]!.details).toBe(`Matched TokoPay transfer tp-route-1 to order ${order.orderCode}.`);
  });

  it("still answers success when the match committed but its audit row could not be written, and logs an error saying so", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-audit-fail", amount: qrisChargeAmount(order.totalAmount) });
    vi.mocked(logAdminAction).mockRejectedValueOnce(new Error("audit table unavailable"));
    const errorSpy = vi.spyOn(logger, "error");
    try {
      const res = await matchWith({ binance_tx_id: "tp-route-audit-fail", order_code: order.orderCode, gateway: "tokopay" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("DELIVERED");
      const call = errorSpy.mock.calls.find((c) => typeof c[1] === "string" && c[1].includes("audit"));
      expect(call).toBeTruthy();
      expect(call![0]).toMatchObject({ adminId: adminUserId, orderId: order.id, reference: "tp-route-audit-fail", gateway: "tokopay" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("puts the storefront order link in the buyer's delivery DM of a QRIS match", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-link", amount: qrisChargeAmount(order.totalAmount) });
    const cfg = config as { SHOP_PUBLIC_URL?: string | null };
    const saved = cfg.SHOP_PUBLIC_URL;
    cfg.SHOP_PUBLIC_URL = "https://shop.example/";
    try {
      const res = await matchWith({ binance_tx_id: "tp-route-link", order_code: order.orderCode, gateway: "tokopay" });
      expect(res.statusCode).toBe(200);
    } finally {
      cfg.SHOP_PUBLIC_URL = saved;
    }
    const dm = await prisma.notificationOutbox.findFirstOrThrow({ where: { event: "ORDER_DELIVERED_DM", orderId: order.id } });
    expect(JSON.parse(dm.payloadJson)).toMatchObject({ order_url: `https://shop.example/account/orders/${order.orderCode}` });
  });

  it("resolves a TokoPay reference without a gateway (the server looks it up across the ledgers)", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-nogw", amount: qrisChargeAmount(order.totalAmount) });

    const res = await matchWith({ binance_tx_id: "tp-route-nogw", order_code: order.orderCode });
    expect(res.statusCode).toBe(200);
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-route-nogw" } })).orderId).toBe(order.id);
  });

  it("writes the acting admin to the audit trail when a TokoPay match credits a wallet top-up", async () => {
    const order = await prisma.$transaction((tx) =>
      createWalletTopupOrder(tx, { userId: sample.user.id, amount: "20000", currency: "IDR", method: PaymentMethod.TOKOPAY }),
    );
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-topup", amount: qrisChargeAmount(order.totalAmount) });

    const res = await matchWith({ binance_tx_id: "tp-route-topup", order_code: order.orderCode, gateway: "tokopay" });
    expect(res.statusCode).toBe(200);

    // settleWalletTopup writes no status-history row, so this audit line is
    // the only place the acting admin is recorded for a top-up.
    const audit = await prisma.auditLog.findMany({ where: { action: "tx_manual_match", targetId: order.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminId).toBe(adminUserId);
    expect(audit[0]!.details).toBe(`Matched TokoPay transfer tp-route-topup to order ${order.orderCode}.`);
  });

  it("names Binance in the audit for a legacy Binance match sent without a gateway", async () => {
    const order = await makePendingOrder();
    await recordUnmatchedTx(prisma, { binanceTxId: "bn-legacy", amount: "1.00" });

    const res = await match("bn-legacy", order.orderCode);
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tx_manual_match", targetId: order.id } });
    expect(audit.details).toBe(`Matched Binance transfer bn-legacy to order ${order.orderCode}.`);
    expect(audit.adminId).toBe(adminUserId);
  });

  it("rejects an unknown gateway with 400 before touching any ledger row", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-badgw", amount: qrisChargeAmount(order.totalAmount) });

    const res = await matchWith({ binance_tx_id: "tp-route-badgw", order_code: order.orderCode, gateway: "paypal" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Unknown payment gateway." });
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-route-badgw" } })).outcome).toBe("unmatched");

    const dis = await dismissWith({ binance_tx_id: "tp-route-badgw", gateway: "paypal" });
    expect(dis.statusCode).toBe(400);
    expect(dis.json()).toEqual({ error: "Unknown payment gateway." });
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-route-badgw" } })).outcome).toBe("unmatched");
  });

  it("refuses a NOWPayments match with the crud's error key", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedNowpaymentsTx(prisma, { trxId: "np-route-1", amount: "0.5" });

    const res = await matchWith({ binance_tx_id: "np-route-1", order_code: order.orderCode, gateway: "nowpayments" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: "error.manual_match_nowpayments_unverifiable" });
    expect(await prisma.auditLog.count({ where: { action: "tx_manual_match" } })).toBe(0);
  });

  it("replays a gateway match for the same key and body, and 409s when only the gateway differs", async () => {
    const order = await makePendingTokopayOrder();
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-idem", amount: qrisChargeAmount(order.totalAmount) });
    const key = "match-gateway-key";
    const body = { binance_tx_id: "tp-route-idem", order_code: order.orderCode, gateway: "tokopay" };

    const first = await matchWith(body, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    const second = await matchWith(body, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });
    expect(await prisma.auditLog.count({ where: { action: "tx_manual_match", targetId: order.id } })).toBe(1);

    // The gateway is part of the request hash: the same reference and order
    // on another gateway is a different request.
    const third = await matchWith({ ...body, gateway: "paydisini" }, { "idempotency-key": key });
    expect(third.statusCode).toBe(409);
    expect(third.json()).toEqual({ error: "idempotency_key_reused" });
  });

  it("dismisses an unmatched TokoPay row and audits the gateway by name", async () => {
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-dismiss", amount: "1000" });

    const res = await dismissWith({ binance_tx_id: "tp-route-dismiss", gateway: "tokopay" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect((await prisma.processedTokopayTx.findUniqueOrThrow({ where: { trxId: "tp-route-dismiss" } })).outcome).toBe("dismissed");

    const audit = await prisma.auditLog.findMany({ where: { action: "tx_dismiss" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.adminId).toBe(adminUserId);
    expect(audit[0]!.details).toBe("Dismissed unmatched TokoPay transfer tp-route-dismiss.");
  });

  it("dismisses an unmatched NOWPayments row", async () => {
    await recordUnmatchedNowpaymentsTx(prisma, { trxId: "np-route-dismiss", amount: "0.5" });

    const res = await dismissWith({ binance_tx_id: "np-route-dismiss", gateway: "nowpayments" });
    expect(res.statusCode).toBe(200);
    expect((await prisma.processedNowpaymentsTx.findUniqueOrThrow({ where: { trxId: "np-route-dismiss" } })).outcome).toBe("dismissed");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tx_dismiss" } });
    expect(audit.details).toBe("Dismissed unmatched NOWPayments transfer np-route-dismiss.");
  });

  it("replays a gateway dismiss for the same key and body, and 409s when only the gateway differs", async () => {
    await recordUnmatchedTokopayTx(prisma, { trxId: "tp-route-dis-idem", amount: "1000" });
    const key = "dismiss-gateway-key";
    const body = { binance_tx_id: "tp-route-dis-idem", gateway: "tokopay" };

    expect((await dismissWith(body, { "idempotency-key": key })).statusCode).toBe(200);
    const again = await dismissWith(body, { "idempotency-key": key });
    expect(again.statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "tx_dismiss" } })).toBe(1);

    const other = await dismissWith({ ...body, gateway: "paydisini" }, { "idempotency-key": key });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toEqual({ error: "idempotency_key_reused" });
  });

  it("still dismisses a legacy Binance transfer sent without a gateway, naming Binance", async () => {
    await recordUnmatchedTx(prisma, { binanceTxId: "bn-legacy-dismiss", amount: "1.00" });
    const res = await dismiss("bn-legacy-dismiss");
    expect(res.statusCode).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "tx_dismiss" } });
    expect(audit.details).toBe("Dismissed unmatched Binance transfer bn-legacy-dismiss.");
    expect(audit.adminId).toBe(adminUserId);
  });
});
