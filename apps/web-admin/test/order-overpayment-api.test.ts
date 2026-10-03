/**
 * Task F2 — the admin API for returning an overpayment.
 *
 * The route is wiring: the amount, every guard and the audit row live in
 * `packages/db/src/crud/overpayments.ts` and are covered by
 * `overpayments.test.ts`. What is tested here is what only the route layer can
 * get wrong, and the first item is the reason the task exists:
 *
 * - **an amount in the request body is ignored.** A credit whose figure came from
 *   the client is a credit an admin (or a crafted request) can set to anything,
 *   with the rail's own record disagreeing and the ledger still balancing — the
 *   one error class double-entry cannot detect. So a body carrying a fat `excess`
 *   must credit the rail's figure and nothing else.
 * - **a wrong-order request cannot reach another order's money.** The order id in
 *   the path is an authorization check, not decoration.
 * - the CSRF trio, the RBAC tier this prefix grants, and the 422 a replayed
 *   request comes back with instead of a second credit.
 * - the detail GET offers the action only while there is an UNCREDITED excess,
 *   with the figure the admin is about to hand over.
 */
import "./setup-env";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";

vi.mock("@app/core/config", async () => {
  const actual = await vi.importActual<typeof import("@app/core/config")>("@app/core/config");
  return { ...actual, config: { ...actual.config, ADMIN_IDS: [444] } };
});

import { config } from "@app/core/config";
import { PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import {
  prisma,
  initDb,
  setSetting,
  createOrderDirect,
  deliverPaidInternalOrder,
  getAccountBalance,
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

/**
 * A DELIVERED order a real rail flagged as overpaid, built by driving
 * `deliverPaidInternalOrder` with more than the order asked for — so the
 * `processedBinanceTx` row the route reads is the one the rail itself wrote,
 * not a hand-made fixture that could agree with nothing.
 */
async function overpaidOrder(excess: Decimal.Value = "3") {
  const order = (await createOrderDirect(prisma, {
    channel: "web",
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
  }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
  });
  const result = await deliverPaidInternalOrder(prisma, {
    orderId: order.id,
    binanceTxId: `tx-over-${order.id}`,
    amount: new Decimal(order.totalAmount).plus(excess),
  });
  expect(result.status).toBe("delivered");
  return order;
}

/** An order nothing flagged — delivered for exactly what it asked for. */
async function exactlyPaidOrder() {
  const order = (await createOrderDirect(prisma, {
    channel: "web",
    user: sample.user,
    productId: sample.product.id,
    quantity: 1,
  }))!;
  await prisma.order.update({
    where: { id: order.id },
    data: { paymentMethod: PaymentMethod.BINANCE_INTERNAL },
  });
  await deliverPaidInternalOrder(prisma, {
    orderId: order.id,
    binanceTxId: `tx-exact-${order.id}`,
    amount: order.totalAmount,
  });
  return order;
}

const buyerBalance = async () =>
  new Decimal((await prisma.user.findUniqueOrThrow({ where: { id: sample.user.id } })).walletBalance);

describe("POST /api/orders/:orderId/credit-overpayment", () => {
  it("credits the rail's excess and reports the amount that moved", async () => {
    const order = await overpaidOrder("3");

    const res = await post(`/api/orders/${order.id}/credit-overpayment`);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; credited: string; currency: string };
    expect(body.ok).toBe(true);
    expect(new Decimal(body.credited).toString()).toBe("3");
    expect(body.currency).toBe("IDR");
    expect((await buyerBalance()).toString()).toBe("3");

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "overpaid_credit" },
    });
    expect(movement.adminId).toBe(adminId);
  });

  it("IGNORES an amount in the request body and credits the rail's figure", async () => {
    const order = await overpaidOrder("3");

    const res = await post(`/api/orders/${order.id}/credit-overpayment`, {
      // A hostile or mistaken client asking for far more than arrived. There is
      // no field on this route that could accept it, and this test is what keeps
      // it that way: the ledger would balance perfectly either way, so no
      // double-entry check downstream would ever catch a body-supplied amount.
      excess: "999999",
      amount: "999999",
      credited: "999999",
    });

    expect(res.statusCode).toBe(200);
    expect(new Decimal((res.json() as { credited: string }).credited).toString()).toBe("3");
    expect((await buyerBalance()).toString()).toBe("3");
  });

  it("keeps the ledger balanced, moving wallet_liability and provider_clearing together", async () => {
    const order = await overpaidOrder("3");
    const walletBefore = await getAccountBalance(prisma, "wallet_liability.idr");
    const clearingBefore = await getAccountBalance(prisma, "provider_clearing.idr");
    const adjustmentBefore = await getAccountBalance(prisma, "adjustment.idr");

    expect((await post(`/api/orders/${order.id}/credit-overpayment`)).statusCode).toBe(200);

    const movement = await prisma.walletTransaction.findFirstOrThrow({
      where: { orderId: order.id, reason: "overpaid_credit" },
    });
    const posting = await prisma.financialTransaction.findUniqueOrThrow({
      where: { idempotencyKey: `wallet:${movement.id}` },
    });
    const entries = await prisma.ledgerEntry.findMany({
      where: { financialTransactionId: posting.id },
    });
    let debits = new Decimal(0);
    let credits = new Decimal(0);
    for (const entry of entries) {
      if (entry.direction === "DEBIT") debits = debits.plus(new Decimal(entry.amount));
      else credits = credits.plus(new Decimal(entry.amount));
    }
    expect(debits.toString()).toBe(credits.toString());

    // The obligation to the buyer grows by 3, and the gateway receivable grows by
    // the same 3 — this excess was never recognised anywhere before, so crediting
    // it recognises the cash for the first time. `provider_clearing` is
    // debit-normal and this posting debits it, which is why it RISES; the only
    // thing that drains it is a provider actually paying out (task F1).
    expect((await getAccountBalance(prisma, "wallet_liability.idr")).minus(walletBefore).toString()).toBe("3");
    expect(
      (await getAccountBalance(prisma, "provider_clearing.idr")).minus(clearingBefore).toString(),
    ).toBe("3");
    // Never equity: the shop did not fund this credit, the buyer did.
    expect((await getAccountBalance(prisma, "adjustment.idr")).toString()).toBe(adjustmentBefore.toString());
  });

  it("422s a second click, so a double-tapped button can never double-credit", async () => {
    const order = await overpaidOrder("3");
    expect((await post(`/api/orders/${order.id}/credit-overpayment`)).statusCode).toBe(200);

    const res = await post(`/api/orders/${order.id}/credit-overpayment`);

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.overpayment_already_credited");
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(1);
    expect((await buyerBalance()).toString()).toBe("3");
  });

  it("422s an order no rail flagged, crediting nothing", async () => {
    const order = await exactlyPaidOrder();

    const res = await post(`/api/orders/${order.id}/credit-overpayment`);

    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe("error.overpayment_none_recorded");
    expect((await buyerBalance()).isZero()).toBe(true);
  });

  it("422s an order that does not exist, and 400s an id that is not one", async () => {
    const missing = await post("/api/orders/999999/credit-overpayment");
    expect(missing.statusCode).toBe(422);
    expect((missing.json() as { error: string }).error).toBe("error.order_not_found");

    for (const bad of ["0", "-1", "abc"]) {
      const res = await post(`/api/orders/${bad}/credit-overpayment`);
      expect(res.statusCode, `id "${bad}" was not refused`).toBe(400);
    }
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(0);
  });

  it("credits the order the URL names and not another one that IS overpaid", async () => {
    // The path is an authorization check: an admin (or a mistyped link) aiming at
    // an order with no excess must not be quietly served the excess of the one
    // next to it.
    const overpaid = await overpaidOrder("3");
    const innocent = await exactlyPaidOrder();

    const res = await post(`/api/orders/${innocent.id}/credit-overpayment`);

    expect(res.statusCode).toBe(422);
    expect((await buyerBalance()).isZero()).toBe(true);
    // The genuinely overpaid order is still uncredited — nothing leaked across.
    expect(
      await prisma.walletTransaction.count({ where: { orderId: overpaid.id, reason: "overpaid_credit" } }),
    ).toBe(0);
  });

  it("writes exactly one audit row — the service's own, never a second from the route", async () => {
    const order = await overpaidOrder("3");

    await post(`/api/orders/${order.id}/credit-overpayment`);

    const rows = await prisma.auditLog.findMany({ where: { action: "overpayment_credit" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.adminId).toBe(adminId);
    expect(rows[0]!.targetId).toBe(order.id);
  });

  it("rejects a request with no CSRF token, before a single rupiah moves", async () => {
    const order = await overpaidOrder("3");

    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/credit-overpayment`,
      payload: {},
      cookies: { [COOKIE]: cookie },
    });

    expect(res.statusCode).toBe(403);
    expect((await buyerBalance()).isZero()).toBe(true);
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(0);
  });

  it("rejects a request with a WRONG CSRF token", async () => {
    const order = await overpaidOrder("3");

    const res = await post(`/api/orders/${order.id}/credit-overpayment`, {}, {
      "x-csrf-token": "not-the-token",
    });

    expect(res.statusCode).toBe(403);
    expect((await buyerBalance()).isZero()).toBe(true);
  });

  it("rejects an unauthenticated request with a JSON 401", async () => {
    const order = await overpaidOrder("3");

    const res = await app.inject({
      method: "POST",
      url: `/api/orders/${order.id}/credit-overpayment`,
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect((await buyerBalance()).isZero()).toBe(true);
  });
});

/**
 * RBAC. This route sits under `/api/orders`, an OPS prefix, so `super` and
 * `support` may use it and `readonly` may not — matching
 * `/api/payments/order/:id/credit-anyway`, the existing route that credits a
 * wallet from a rail-recorded amount. Both the grant and the refusal are
 * asserted: the grant is the deliberate part of the placement, and a prefix list
 * that has drifted looks identical to a correct one if only refusals are tested.
 */
describe("RBAC on returning an overpayment", () => {
  const setRole = (role: string) => setSetting(prisma, webRoleKey(ADMIN_TG), role);

  it("403s a readonly admin, crediting nothing", async () => {
    const order = await overpaidOrder("3");
    await setRole("readonly");

    const res = await post(`/api/orders/${order.id}/credit-overpayment`);

    expect(res.statusCode).toBe(403);
    expect((await buyerBalance()).isZero()).toBe(true);
    expect(await prisma.walletTransaction.count({ where: { reason: "overpaid_credit" } })).toBe(0);
  });

  it("allows a support admin — the same tier that credits an underpaid top-up", async () => {
    const order = await overpaidOrder("3");
    await setRole("support");

    const res = await post(`/api/orders/${order.id}/credit-overpayment`);

    expect(res.statusCode).toBe(200);
    expect((await buyerBalance()).toString()).toBe("3");
  });

  it("allows a super admin", async () => {
    const order = await overpaidOrder("3");
    await setRole("super");

    expect((await post(`/api/orders/${order.id}/credit-overpayment`)).statusCode).toBe(200);
  });
});

describe("GET /api/orders/:orderId — the overpayment the page acts on", () => {
  it("carries the rail's figures while the excess is uncredited", async () => {
    const order = await overpaidOrder("3");

    const res = await get(`/api/orders/${order.id}`);

    expect(res.statusCode).toBe(200);
    const overpayment = (res.json() as {
      overpayment: {
        gateway: string;
        receivedAmount: string;
        expectedAmount: string;
        excess: string;
        currency: string;
        credited: boolean;
      } | null;
    }).overpayment;
    expect(overpayment).not.toBeNull();
    expect(overpayment!.gateway).toBe(PaymentMethod.BINANCE_INTERNAL);
    expect(new Decimal(overpayment!.excess).toString()).toBe("3");
    expect(new Decimal(overpayment!.receivedAmount).minus(overpayment!.expectedAmount).toString()).toBe("3");
    expect(overpayment!.currency).toBe("IDR");
    expect(overpayment!.credited).toBe(false);
  });

  it("marks it credited once it has been returned, so the action stops being offered", async () => {
    const order = await overpaidOrder("3");
    await post(`/api/orders/${order.id}/credit-overpayment`);

    const res = await get(`/api/orders/${order.id}`);

    const overpayment = (res.json() as { overpayment: { credited: boolean; excess: string } }).overpayment;
    expect(overpayment.credited).toBe(true);
    // The excess itself is still reported — the page shows what was handed back
    // rather than the record vanishing once it is resolved.
    expect(new Decimal(overpayment.excess).toString()).toBe("3");
  });

  it("sends null for an ordinary order nobody overpaid", async () => {
    const order = await exactlyPaidOrder();

    const res = await get(`/api/orders/${order.id}`);

    expect((res.json() as { overpayment: unknown }).overpayment).toBeNull();
  });
});
