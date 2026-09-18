/**
 * Financial Ledger M20 — the admin API for account/stock replacement.
 *
 * These three routes are wiring only: every guard, every amount and every
 * audit line lives in `packages/db/src/crud/stockReplacement.ts` (M19) and is
 * covered by its own suite. What is tested here is what only the route layer
 * can get wrong — the order/unit the URL names really is the one acted on, a
 * service `ValidationError` surfaces as the 422 this file's neighbours use, a
 * missing reason is refused before anything is written, and the success bodies
 * say enough for the admin panel to report what actually happened.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";
import { RefundExecutionMethod, StockReplacementStatus, StockStatus } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import {
  prisma,
  initDb,
  setSetting,
  approveOrder,
  attachPaymentProof,
  bulkAddStock,
  createOrderDirect,
  replaceStockItem,
} from "@app/db";
import { resetDb, buildSampleData, type SampleData } from "../../../tests/helpers/sampleData";
import { buildApp } from "../src/server";
import { makeSession, sessionJtiKey, newJti } from "../src/auth";

const ADMIN_TG = 999;
const COOKIE = config.WEB_COOKIE_NAME;
let app: FastifyInstance;
let cookie: string;
let csrf: string;
let sample: SampleData;
let adminId: number;

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
  const admin = await prisma.user.create({
    data: {
      telegramId: ADMIN_TG,
      username: "admin",
      fullName: "Admin",
      role: "ADMIN",
      referralCode: `a${Math.random()}`,
    },
  });
  adminId = admin.id;
  const jti = newJti();
  await setSetting(prisma, sessionJtiKey(ADMIN_TG), jti);
  const { raw, data } = makeSession(admin.id, ADMIN_TG, jti);
  cookie = raw;
  csrf = data.csrf;
  await setSetting(prisma, "setup_completed", "true");
});

/**
 * A DELIVERED order whose every unit holds its own SOLD credential, with the
 * SKU's remaining spares drained — the same fixture shape
 * `stockReplacement.test.ts` uses, so "there is nothing to replace it with" is
 * the default and `restock()` is the explicit opt-in.
 */
async function makeDeliveredOrder(quantity = 1) {
  const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
  const created = await createOrderDirect(prisma, {
    user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
    productId: sample.product.id,
    quantity,
  });
  await attachPaymentProof(prisma, created!.id, { fileId: "proof", txid: `TX-${created!.id}` });
  await approveOrder(prisma, created!.id, { adminId });
  await prisma.stockItem.deleteMany({
    where: { productId: sample.product.id, status: StockStatus.AVAILABLE },
  });
  const items = await prisma.orderItem.findMany({
    where: { orderId: created!.id },
    orderBy: { id: "asc" },
  });
  return { order: created!, items };
}

async function restock(count = 1) {
  await bulkAddStock(
    prisma,
    sample.product.id,
    Array.from({ length: count }, () => `spare-${Math.random()}@example.com:pwd`),
  );
}

function post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url,
    payload: body as Record<string, unknown>,
    headers: { "x-csrf-token": csrf, ...headers },
    cookies: { [COOKIE]: cookie },
  });
}

function get(url: string) {
  return app.inject({ method: "GET", url, cookies: { [COOKIE]: cookie } });
}

describe("POST /api/orders/:orderId/items/:orderItemId/replace", () => {
  it("swaps the credential and reports the request as completed when a spare exists", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const originalStockId = items[0]!.stockItemId!;
    await restock(1);

    const res = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, {
      reason: "password changed by the account owner",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; status: string; credentialIssued: boolean; replacementId: number };
    expect(body.ok).toBe(true);
    expect(body.status).toBe(StockReplacementStatus.COMPLETED);
    expect(body.credentialIssued).toBe(true);

    const request = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: body.replacementId } });
    expect(request.orderItemId).toBe(items[0]!.id);
    expect(request.requestedBy).toBe(adminId);
    expect(request.reason).toBe("password changed by the account owner");
    expect(request.supportTicketId).toBeNull();

    const original = await prisma.stockItem.findUniqueOrThrow({ where: { id: originalStockId } });
    expect(original.status).toBe(StockStatus.DEAD);
    const reloadedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: items[0]!.id } });
    expect(reloadedItem.stockItemId).not.toBe(originalStockId);
  });

  it("reports a request parked at AWAITING_STOCK when the SKU has no spare", async () => {
    const { order, items } = await makeDeliveredOrder(1);

    const res = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, {
      reason: "account banned within 24h",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; credentialIssued: boolean };
    expect(body.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(body.credentialIssued).toBe(false);
  });

  it("records the support ticket the complaint arrived on when the caller names one", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "akun tidak bisa dipakai" },
    });

    const res = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, {
      reason: "cannot log in",
      supportTicketId: ticket.id,
    });

    expect(res.statusCode).toBe(200);
    const request = await prisma.stockReplacement.findFirstOrThrow({ where: { orderItemId: items[0]!.id } });
    expect(request.supportTicketId).toBe(ticket.id);
  });

  it("writes exactly one audit row — the service's own, never a second one from the route", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);

    await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, { reason: "dead" });

    const rows = await prisma.auditLog.findMany({ where: { targetType: "stock_replacement" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
  });

  it("refuses an empty reason before anything is written", async () => {
    const { order, items } = await makeDeliveredOrder(1);

    const res = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, { reason: "   " });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/required/i);
    expect(await prisma.stockReplacement.count()).toBe(0);
  });

  it("404s for a unit that belongs to a different order than the URL names", async () => {
    const mine = await makeDeliveredOrder(1);
    await restock(1);
    const other = await makeDeliveredOrder(1);

    const res = await post(`/api/orders/${mine.order.id}/items/${other.items[0]!.id}/replace`, {
      reason: "wrong order",
    });

    expect(res.statusCode).toBe(404);
    expect(await prisma.stockReplacement.count()).toBe(0);
  });

  it("surfaces the service's own guard as a 422 carrying its error key", async () => {
    // An order that was never delivered — `replaceStockItem`'s first guard.
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    const created = await createOrderDirect(prisma, {
      user: { id: buyer.id, role: buyer.role, walletBalance: buyer.walletBalance },
      productId: sample.product.id,
      quantity: 1,
    });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created!.id } });

    const res = await post(`/api/orders/${created!.id}/items/${item.id}/replace`, { reason: "dead" });

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.stock_replacement_order_not_delivered");
  });

  it("rejects a request with no CSRF token", async () => {
    const { order, items } = await makeDeliveredOrder(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/items/${items[0]!.id}/replace`,
      payload: { reason: "dead" },
      cookies: { [COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(await prisma.stockReplacement.count()).toBe(0);
  });
});

describe("POST /api/orders/:orderId/replacements/:replacementId/retry", () => {
  it("hands over a restocked credential and reports the request completed", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    await restock(1);

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/retry`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      status: StockReplacementStatus.COMPLETED,
      credentialIssued: true,
    });
    const reloaded = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(reloaded.status).toBe(StockReplacementStatus.COMPLETED);
  });

  it("says plainly that nothing was allocated when the SKU is still empty", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/retry`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      status: StockReplacementStatus.AWAITING_STOCK,
      credentialIssued: false,
    });
  });

  it("422s a request that is no longer awaiting stock", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    await restock(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.COMPLETED);

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/retry`);

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.stock_replacement_not_awaiting_stock");
  });

  it("404s a replacement that belongs to a different order than the URL names", async () => {
    const mine = await makeDeliveredOrder(1);
    await restock(1);
    const other = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: other.items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });

    const res = await post(`/api/orders/${mine.order.id}/replacements/${replacement.id}/retry`);

    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/orders/:orderId/replacements/:replacementId/refund", () => {
  async function awaitingStockRequest() {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "no stock to replace it with",
      executedBy: adminId,
    });
    expect(replacement.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    return { order, items, replacement };
  }

  it("pays the unit back to the buyer's wallet and reports how much moved", async () => {
    const { order, items, replacement } = await awaitingStockRequest();
    const unitPrice = new Decimal(items[0]!.unitPrice);

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; refunded: string; currency: string };
    expect(body.ok).toBe(true);
    expect(new Decimal(body.refunded).equals(unitPrice)).toBe(true);
    expect(body.currency).toBe(order.currency);

    const reloaded = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(reloaded.status).toBe(StockReplacementStatus.REFUNDED_INSTEAD);
    expect(reloaded.refundId).not.toBeNull();
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).equals(unitPrice)).toBe(true);
  });

  it("422s a second payout attempt, so one unit can never be paid for twice", async () => {
    const { order, replacement } = await awaitingStockRequest();
    expect((await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`)).statusCode).toBe(200);

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`);

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.stock_replacement_not_awaiting_stock");
    expect(await prisma.refundExecution.count()).toBe(1);
  });

  it("422s a MANUAL_TRANSFER payout with no proof of the transfer, leaving nothing half-written", async () => {
    const { order, replacement } = await awaitingStockRequest();

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`, {
      method: RefundExecutionMethod.MANUAL_TRANSFER,
    });

    expect(res.statusCode).toBe(422);
    expect(await prisma.refund.count()).toBe(0);
    const reloaded = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(reloaded.status).toBe(StockReplacementStatus.AWAITING_STOCK);
  });

  it("400s an unknown payout method rather than passing it through to the ledger", async () => {
    const { order, replacement } = await awaitingStockRequest();

    const res = await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`, {
      method: "CASH_IN_A_BROWN_ENVELOPE",
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.refund.count()).toBe(0);
  });
});

describe("GET /api/orders/:orderId — replacement history", () => {
  it("carries every unit's replacement requests, with the refund amount for a refunded one", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead on arrival",
      executedBy: adminId,
    });

    const before = await get(`/api/orders/${order.id}`);
    expect(before.statusCode).toBe(200);
    const pending = (before.json() as { stockReplacements: Record<string, unknown>[] }).stockReplacements;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: replacement.id,
      orderItemId: items[0]!.id,
      status: StockReplacementStatus.AWAITING_STOCK,
      reason: "dead on arrival",
      resolvedAt: null,
      refund: null,
    });
    expect(pending[0]!.requestedAtDisplay).toEqual(expect.any(String));

    await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`);

    const after = await get(`/api/orders/${order.id}`);
    const settled = (after.json() as { stockReplacements: Record<string, unknown>[] }).stockReplacements;
    expect(settled[0]).toMatchObject({ status: StockReplacementStatus.REFUNDED_INSTEAD });
    expect(settled[0]!.resolvedAtDisplay).toEqual(expect.any(String));
    const refund = settled[0]!.refund as { amount: string; currency: string };
    expect(new Decimal(refund.amount).equals(new Decimal(items[0]!.unitPrice))).toBe(true);
    expect(refund.currency).toBe(order.currency);
  });

  it("carries an empty list for an order nobody has complained about", async () => {
    const { order } = await makeDeliveredOrder(1);
    const res = await get(`/api/orders/${order.id}`);
    expect((res.json() as { stockReplacements: unknown[] }).stockReplacements).toEqual([]);
  });
});
