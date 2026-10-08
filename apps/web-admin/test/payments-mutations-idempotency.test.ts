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
import { prisma, initDb, setSetting, markUnderpaid, createOrderDirect, createInternalOrder, recordUnmatchedTx, triggerDigiflazzDispatch } from "@app/db";
import { routeOrderToDigiflazz } from "../../../tests/helpers/digiflazzRouting";

// The instant Digiflazz dispatch is observed, not run: the manual-match test
// checks that it is started for a PROCESSING settlement, not what Digiflazz answers.
vi.mock("@app/db", async (orig) => ({
  ...(await orig<typeof import("@app/db")>()),
  triggerDigiflazzDispatch: vi.fn(),
}));
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
