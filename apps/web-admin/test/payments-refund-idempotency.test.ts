/**
 * Task 1: Idempotency-Key on POST /api/payments/order/:orderId/refund — a
 * double-clicked "Refund" button (or a retried request after the admin's
 * browser never saw the first response) must replay the exact first
 * response instead of hitting refundUnderpaidOrder's own state guard (which
 * would otherwise show a confusing 422 "order not underpaid" on the retry,
 * even though the refund already happened).
 *
 * Also covers what the route reports back: `refunded`/`currency` in the success
 * body, including the zero-refund case where the order goes REFUNDED but no
 * money moves (see the second describe at the bottom).
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
  const order = (await createOrderDirect(prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
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

describe("POST /api/payments/order/:orderId/refund — audit is atomic with the refund (Task C3)", () => {
  it("a failed audit insert rolls the whole refund back: no wallet credit, order stays UNDERPAID", async () => {
    const order = await makeUnderpaidOrder("tx-audit-atomic");
    // Force the audit insert to fail: audit_logs.admin_id references users,
    // so once the acting admin's row is gone the insert is an FK violation
    // (same technique as web.test.ts's dismiss-atomicity test). Nothing else
    // in the refund references the admin row, so only the audit write fails.
    const admin = await prisma.user.findFirstOrThrow({ where: { telegramId: ADMIN_TG } });
    await prisma.user.delete({ where: { id: admin.id } });

    const res = await refund(order.id);
    expect(res.statusCode).toBe(500);

    expect(await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } })).toHaveLength(0);
    expect(await prisma.refund.findMany({ where: { orderId: order.id } })).toHaveLength(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("UNDERPAID");
  });
});

describe("POST /api/payments/order/:orderId/refund — Idempotency-Key", () => {
  it("with no header: two refund attempts on the same order behave as before (first succeeds, second 422s)", async () => {
    const order = await makeUnderpaidOrder("tx-no-header");

    const first = await refund(order.id);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, refunded: "1", currency: order.currency });

    const second = await refund(order.id);
    expect(second.statusCode).toBe(422);
  });

  it("replays the exact success response for a repeated request with the same key, refunding only once", async () => {
    const order = await makeUnderpaidOrder("tx-replay-success");
    const key = "refund-key-1";

    const first = await refund(order.id, { "idempotency-key": key });
    expect(first.statusCode).toBe(200);
    // `refunded`/`currency` come back so the admin panel can say how much
    // actually went back to the buyer instead of showing an unconditional
    // success toast — mirroring the sibling /credit-anyway route.
    expect(first.json()).toEqual({ ok: true, refunded: "1", currency: order.currency });

    const second = await refund(order.id, { "idempotency-key": key });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true, refunded: "1", currency: order.currency });

    // Refunded exactly once — the buyer's wallet only got credited on the
    // first attempt, and the audit log only recorded one refund action.
    const walletTx = await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } });
    expect(walletTx).toHaveLength(1);
    const auditRows = await prisma.auditLog.findMany({ where: { action: "underpaid_refund", targetId: order.id } });
    expect(auditRows).toHaveLength(1);

    // Task 8b: refundUnderpaidOrder now also writes a Refund record — exactly
    // one, already COMPLETED (the wallet credit already happened), never
    // duplicated by a replayed idempotent request.
    const refunds = await prisma.refund.findMany({ where: { orderId: order.id } });
    expect(refunds).toHaveLength(1);
    const refundRow = refunds[0]!;
    expect(refundRow.status).toBe("COMPLETED");
    expect(refundRow.amount.toString()).toBe("1");
    expect(refundRow.currency).toBe(order.currency);
    expect(refundRow.processedAt).toBeInstanceOf(Date);
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

describe("POST /api/payments/order/:orderId/refund — when no rail recorded what the buyer sent", () => {
  it("reports refunded 0 and says so in the audit log instead of claiming a payout", async () => {
    // An order moved to UNDERPAID with no ledger row behind it — the shape
    // every PRODUCT order that was already sitting in UNDERPAID before this
    // branch's QRIS ledger table landed has. The route still marks it
    // REFUNDED (terminal), so it has to say plainly that no money moved.
    const order = (await createOrderDirect(prisma, { channel: "web", user: sample.user, productId: sample.product.id, quantity: 1 }))!;
    await prisma.order.update({ where: { id: order.id }, data: { status: "UNDERPAID" } });
    const buyerBefore = (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance.toString();

    const res = await refund(order.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, refunded: "0", currency: order.currency });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");

    // No wallet movement, and no COMPLETED Refund row implying a payout.
    const buyerAfter = (await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance.toString();
    expect(buyerAfter).toBe(buyerBefore);
    expect(await prisma.walletTransaction.findMany({ where: { orderId: order.id, reason: "underpaid_refund" } })).toHaveLength(0);
    expect(await prisma.refund.findMany({ where: { orderId: order.id } })).toHaveLength(0);

    const audit = await prisma.auditLog.findMany({ where: { action: "underpaid_refund", targetId: order.id } });
    expect(audit).toHaveLength(1);
    // Not "Refunded 0 IDR …", which reads as a completed zero-value payout.
    expect(audit[0]!.details).toContain("returned nothing");
    expect(audit[0]!.details).toContain("by hand");
  });
});
