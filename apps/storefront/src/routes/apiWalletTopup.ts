/**
 * Wallet top-up — buy wallet CREDIT itself through the existing payment
 * gateways rather than paying for a product (packages/db/src/crud/wallet_topup.ts).
 * Session-locked throughout: a guest has no durable wallet identity to top up,
 * so every route here requires a signed-in customer (401 JSON, mirroring
 * apiAccount.ts/apiCheckout.ts's `requireCustomer` — never the HTML routes'
 * 303 redirect).
 *
 * Reuses payView/payState/cancelOrder from routes/checkout.ts + @app/db
 * UNCHANGED for the pay/status/cancel wrappers — they only ever read `Order`
 * columns, never `items`, so they render a WALLET_TOPUP order exactly as they
 * render a PRODUCT one. This file's own job is just the create-order step
 * (gateway-method validation + createWalletTopupOrder) and the three
 * ownership-checked wrappers around those shared helpers.
 */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { OrderKind, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import {
  prisma,
  getOrderByCode,
  cancelOrder,
  getUsdIdrRate,
  getTokopayCreds,
  resolveBybitConfig,
  resolveBybitBscConfig,
  resolveBinanceInternalConfig,
  getPaydisiniCreds,
  getNowpaymentsCreds,
  resolveWalletTopupLimits,
  createWalletTopupOrder,
  type WalletTopupIdrMethod,
  type WalletTopupUsdtMethod,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { constantTimeEqual } from "../auth";
import { payView, payState } from "./checkout";

/** JSON-flavored auth gate: 401 body instead of the HTML routes' 303 — same
 * helper apiAccount.ts/apiCheckout.ts each define locally for their own file. */
async function requireCustomer(req: FastifyRequest, reply: FastifyReply): Promise<Customer | null> {
  const customer = await optionalCustomer(req);
  if (!customer) {
    void reply.code(401).send({ error: "unauthorized" });
    return null;
  }
  return customer;
}

/** x-csrf-token header check for signed-in JSON mutations — same contract as
 * apiAccount.ts's csrfHeaderOk (this file has no anonymous path, unlike
 * apiCheckout.ts's csrfOk, so there is no guest bypass to preserve). */
function csrfHeaderOk(req: FastifyRequest, customer: Customer): boolean {
  const token = req.headers["x-csrf-token"];
  return typeof token === "string" && constantTimeEqual(token, customer.csrf);
}

/** Look up an order by code and enforce BOTH ownership and
 * kind === WALLET_TOPUP. 404 (never 403) on either failure, matching every
 * other ownership check in this app (apiCheckout.ts, apiAccount.ts) — a buyer
 * probing codes can't tell "not yours" from "not a top-up" from "doesn't
 * exist". */
async function loadOwnedTopup(code: string, customer: Customer) {
  const order = await getOrderByCode(prisma, code);
  if (!order || order.userId !== customer.userId || order.kind !== OrderKind.WALLET_TOPUP) {
    return null;
  }
  return order;
}

const apiWalletTopupRoutes: FastifyPluginAsync = async (app) => {
  // ---- Gateway availability + limits + current balances ----
  app.get("/wallet/topup", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;

    const [fxRate, tokopay, bybit, bybitBsc, binance, paydisini, nowpayments, limits] = await Promise.all([
      getUsdIdrRate(prisma),
      getTokopayCreds(prisma),
      resolveBybitConfig(prisma),
      resolveBybitBscConfig(prisma),
      resolveBinanceInternalConfig(prisma),
      getPaydisiniCreds(prisma),
      getNowpaymentsCreds(prisma),
      resolveWalletTopupLimits(prisma),
    ]);
    const haveRate = Boolean(fxRate);

    return reply.send({
      idr_enabled: Boolean(tokopay),
      paydisini_enabled: Boolean(paydisini),
      binance_enabled: haveRate && binance.enabled,
      bybit_enabled: haveRate && bybit.enabled,
      bybit_bsc_enabled: haveRate && bybitBsc.enabled,
      nowpayments_enabled: haveRate && Boolean(nowpayments),
      min_idr: limits.minIdr ? limits.minIdr.toString() : null,
      max_idr: limits.maxIdr ? limits.maxIdr.toString() : null,
      min_usdt: limits.minUsdt ? limits.minUsdt.toString() : null,
      max_usdt: limits.maxUsdt ? limits.maxUsdt.toString() : null,
      wallet_idr: new Decimal(customer.user.walletBalance).toString(),
      wallet_usdt: new Decimal(customer.user.walletBalanceUsdt).toString(),
    });
  });

  // ---- Create a top-up order ----
  // Method tokens mirror performCheckout's (routes/checkout.ts) exactly —
  // same "if (method === 'qris') { if (!tokopay) throw ... }" gating pattern
  // — so the two forms stay recognizable as siblings. createWalletTopupOrder
  // re-validates the amount against resolveWalletTopupLimits itself; this
  // route's own job is only the method/currency gate (does an enabled
  // gateway back this token?) that createWalletTopupOrder has no way to
  // check on its own (it doesn't know which gateways are configured).
  app.post<{ Body: { currency?: string; amount?: string; method?: string } }>("/wallet/topup", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });

    const [fxRate, tokopay, bybit, bybitBsc, binance, paydisini, nowpayments] = await Promise.all([
      getUsdIdrRate(prisma),
      getTokopayCreds(prisma),
      resolveBybitConfig(prisma),
      resolveBybitBscConfig(prisma),
      resolveBinanceInternalConfig(prisma),
      getPaydisiniCreds(prisma),
      getNowpaymentsCreds(prisma),
    ]);

    type Choice =
      | { currency: "IDR"; method: WalletTopupIdrMethod }
      | { currency: "USDT"; method: WalletTopupUsdtMethod; rate: NonNullable<typeof fxRate> };
    let choice: Choice;
    const method = req.body?.method;
    if (method === "qris") {
      if (!tokopay) return reply.code(400).send({ error: "web.pay_method_unavailable" });
      choice = { currency: "IDR", method: PaymentMethod.TOKOPAY };
    } else if (method === "paydisini") {
      if (!paydisini) return reply.code(400).send({ error: "web.pay_method_unavailable" });
      choice = { currency: "IDR", method: PaymentMethod.PAYDISINI };
    } else if (method === "binance") {
      if (!fxRate || !binance.enabled) return reply.code(400).send({ error: "web.pay_method_unavailable" });
      choice = { currency: "USDT", method: PaymentMethod.BINANCE_INTERNAL, rate: fxRate };
    } else if (method === "bybit") {
      if (!fxRate || !bybit.enabled) return reply.code(400).send({ error: "web.pay_method_unavailable" });
      choice = { currency: "USDT", method: PaymentMethod.BYBIT, rate: fxRate };
    } else if (method === "bybit_bsc") {
      if (!fxRate || !bybitBsc.enabled) return reply.code(400).send({ error: "web.pay_method_unavailable" });
      choice = { currency: "USDT", method: PaymentMethod.BYBIT_BSC, rate: fxRate };
    } else if (method === "nowpayments") {
      if (!fxRate || !nowpayments) return reply.code(400).send({ error: "web.pay_method_unavailable" });
      choice = { currency: "USDT", method: PaymentMethod.NOWPAYMENTS, rate: fxRate };
    } else {
      return reply.code(400).send({ error: "web.pay_method_unavailable" });
    }

    // currency/method mismatch: the client always sends `currency` alongside
    // `method` (it picks the method from within one currency's gateway list),
    // so disagreement between the two means a stale/tampered request — reject
    // rather than silently trusting one field over the other.
    if (req.body?.currency !== choice.currency) {
      return reply.code(400).send({ error: "web.pay_method_unavailable" });
    }

    try {
      const order = await prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: customer.userId,
          amount: req.body?.amount ?? "0",
          currency: choice.currency,
          method: choice.method,
          ...(choice.currency === "USDT" ? { rate: choice.rate } : {}),
        }),
      );
      return reply.code(201).send({ orderCode: order.orderCode });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.key });
      throw e;
    }
  });

  // ---- Pay page data — thin wrapper around the SAME payView() a product
  // order's pay page uses (routes/checkout.ts); only the ownership+kind gate
  // is specific to this file. ----
  app.get<{ Params: { code: string } }>("/wallet/topup/:code/pay", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const order = await loadOwnedTopup(req.params.code, customer);
    if (!order) return reply.code(404).send({ error: "not_found" });
    return reply.send(await payView(order));
  });

  // ---- Status poll — thin wrapper around payState(). Redirects to /account
  // once delivered (not /account/orders/:code — a top-up is never a "My
  // Orders" purchase; the credited balance shows up on the account page). ----
  app.get<{ Params: { code: string } }>("/wallet/topup/:code/status", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    const order = await loadOwnedTopup(req.params.code, customer);
    if (!order) return reply.code(404).send({ error: "not_found" });
    const state = payState(order);
    return reply.send({ state, redirect: state === "delivered" ? "/account" : null });
  });

  // ---- Buyer cancels a still-pending top-up ----
  app.post<{ Params: { code: string } }>("/wallet/topup/:code/cancel", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const order = await loadOwnedTopup(req.params.code, customer);
    if (!order) return reply.code(404).send({ error: "not_found" });
    try {
      await prisma.$transaction((tx) => cancelOrder(tx, order.id, "user_cancelled"));
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e; // already paid/delivered → just bounce
    }
    return reply.send({ ok: true });
  });
};

export default apiWalletTopupRoutes;
