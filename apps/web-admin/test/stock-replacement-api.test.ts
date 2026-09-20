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
import { makeSession, sessionJtiKey, newJti, webRoleKey } from "../src/auth";

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
      data: { userId: sample.user.id, orderId: order.id, message: "akun tidak bisa dipakai" },
    });

    const res = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, {
      reason: "cannot log in",
      supportTicketId: ticket.id,
    });

    expect(res.statusCode).toBe(200);
    const request = await prisma.stockReplacement.findFirstOrThrow({ where: { orderItemId: items[0]!.id } });
    expect(request.supportTicketId).toBe(ticket.id);
  });

  it("refuses a ticket that belongs to a DIFFERENT order than the URL names", async () => {
    const mine = await makeDeliveredOrder(1);
    await restock(1);
    const other = await makeDeliveredOrder(1);
    // A real ticket, but about somebody else's purchase: stamping it onto this
    // request would send every later reader of the replacement to the wrong
    // complaint.
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, orderId: other.order.id, message: "another order's problem" },
    });

    const res = await post(`/api/orders/${mine.order.id}/items/${mine.items[0]!.id}/replace`, {
      reason: "cannot log in",
      supportTicketId: ticket.id,
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not about this order/i);
    // Refused BEFORE anything was written — no request, and the delivered
    // credential is still SOLD rather than retired.
    expect(await prisma.stockReplacement.count()).toBe(0);
    const stock = await prisma.stockItem.findUniqueOrThrow({ where: { id: mine.items[0]!.stockItemId! } });
    expect(stock.status).toBe(StockStatus.SOLD);
  });

  it("refuses a ticket with no order link at all, rather than guessing it is about this one", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const ticket = await prisma.supportTicket.create({
      data: { userId: sample.user.id, message: "general question, no order attached" },
    });

    const res = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, {
      reason: "cannot log in",
      supportTicketId: ticket.id,
    });

    expect(res.statusCode).toBe(400);
    expect(await prisma.stockReplacement.count()).toBe(0);
  });

  it("reports the buyer as notified when they have Telegram, and NOT when they are reachable by nobody", async () => {
    const reachable = await makeDeliveredOrder(1);
    await restock(1);
    const withTelegram = await post(
      `/api/orders/${reachable.order.id}/items/${reachable.items[0]!.id}/replace`,
      { reason: "dead" },
    );
    expect(withTelegram.statusCode).toBe(200);
    expect((withTelegram.json() as { buyerNotified: boolean }).buyerNotified).toBe(true);

    // Same shop, a web buyer who never linked Telegram and left no guest email:
    // the credential is swapped but there is no rail to tell them about it, and
    // the panel must not claim one was used (`enqueueOrderDeliveredDm` returns
    // silently for a null telegramId).
    await prisma.user.update({
      where: { id: sample.user.id },
      data: { telegramId: null, isGuest: false, guestEmail: null },
    });
    // One credential for the second order to be delivered with, then one more
    // for its replacement — `makeDeliveredOrder` drains whatever it leaves over.
    await restock(1);
    const unreachable = await makeDeliveredOrder(1);
    await restock(1);

    const res = await post(
      `/api/orders/${unreachable.order.id}/items/${unreachable.items[0]!.id}/replace`,
      { reason: "dead" },
    );

    expect(res.statusCode).toBe(200);
    const body = res.json() as { credentialIssued: boolean; buyerNotified: boolean };
    expect(body.credentialIssued).toBe(true);
    expect(body.buyerNotified).toBe(false);
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
      buyerNotified: true,
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
      buyerNotified: false,
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

  it("rejects a request with no CSRF token", async () => {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    await restock(1);

    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/replacements/${replacement.id}/retry`,
      payload: {},
      cookies: { [COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(403);
    const unchanged = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(unchanged.status).toBe(StockReplacementStatus.AWAITING_STOCK);
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

  it("rejects a request with no CSRF token, before a single rupiah moves", async () => {
    const { order, replacement } = await awaitingStockRequest();

    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/replacements/${replacement.id}/refund`,
      payload: {},
      cookies: { [COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(403);
    expect(await prisma.refund.count()).toBe(0);
    expect(await prisma.refundExecution.count()).toBe(0);
    const buyer = await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } });
    expect(new Decimal(buyer.walletBalance).isZero()).toBe(true);
  });
});

/**
 * RBAC. All three routes sit under `/api/orders`, which is an OPS prefix
 * (plugins/auth.ts): `super` and `support` may mutate it, `readonly` may not.
 * That placement is the whole reason these routes are nested under the order
 * rather than living at `/api/stock-replacements` — a new top-level prefix would
 * default to deny and lock the support role out of a complaint it is expected to
 * handle — so it is worth a test that the intended grant really landed rather
 * than only the refusal.
 *
 * The role is resolved per request from the `web_admin_role:<telegramId>`
 * Setting, so flipping it on the session already in hand is enough (same
 * technique as adminTasks-api.test.ts).
 */
describe("RBAC on the three replacement mutations", () => {
  const setRole = (role: string) => setSetting(prisma, webRoleKey(ADMIN_TG), role);

  /** One AWAITING_STOCK request plus a restocked SKU, so every route below has
   *  something it could legitimately do if the role were allowed to. */
  async function ready() {
    const { order, items } = await makeDeliveredOrder(1);
    const { replacement } = await replaceStockItem(prisma, {
      orderItemId: items[0]!.id,
      reason: "dead",
      executedBy: adminId,
    });
    await restock(1);
    return { order, items, replacement };
  }

  it("403s a readonly admin on all three, changing nothing", async () => {
    const { order, replacement } = await ready();
    const secondUnit = await makeDeliveredOrder(1);
    await setRole("readonly");

    const replace = await post(`/api/orders/${secondUnit.order.id}/items/${secondUnit.items[0]!.id}/replace`, {
      reason: "dead",
    });
    const retry = await post(`/api/orders/${order.id}/replacements/${replacement.id}/retry`);
    const refund = await post(`/api/orders/${order.id}/replacements/${replacement.id}/refund`);

    expect([replace.statusCode, retry.statusCode, refund.statusCode]).toEqual([403, 403, 403]);
    // The one pre-existing request is untouched and no second one was opened.
    expect(await prisma.stockReplacement.count()).toBe(1);
    const unchanged = await prisma.stockReplacement.findUniqueOrThrow({ where: { id: replacement.id } });
    expect(unchanged.status).toBe(StockReplacementStatus.AWAITING_STOCK);
    expect(await prisma.refund.count()).toBe(0);
    const stillSold = await prisma.stockItem.findUniqueOrThrow({ where: { id: secondUnit.items[0]!.stockItemId! } });
    expect(stillSold.status).toBe(StockStatus.SOLD);
  });

  it("allows a support admin to replace, retry and refund — the role this feature exists for", async () => {
    const { order, items, replacement } = await ready();
    await setRole("support");

    const retry = await post(`/api/orders/${order.id}/replacements/${replacement.id}/retry`);
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { credentialIssued: boolean }).credentialIssued).toBe(true);

    // A fresh complaint against the credential support just handed over, then
    // the refund fallback on it once the SKU is empty again.
    const reopened = await post(`/api/orders/${order.id}/items/${items[0]!.id}/replace`, {
      reason: "the replacement was dead too",
    });
    expect(reopened.statusCode).toBe(200);
    const reopenedBody = reopened.json() as { replacementId: number; status: string };
    expect(reopenedBody.status).toBe(StockReplacementStatus.AWAITING_STOCK);

    const refund = await post(`/api/orders/${order.id}/replacements/${reopenedBody.replacementId}/refund`);
    expect(refund.statusCode).toBe(200);
    expect(await prisma.refundExecution.count()).toBe(1);
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
