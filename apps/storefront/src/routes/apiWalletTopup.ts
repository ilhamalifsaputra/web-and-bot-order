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
import { OrderKind, PaymentMethod, StockActorType } from "@app/core/enums";
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
  resolveWalletTopupRailFloor,
  resolveWalletTopupEffectiveMin,
  createWalletTopupOrder,
  type WalletTopupIdrMethod,
  type WalletTopupUsdtMethod,
  type WalletTopupMethod,
} from "@app/db";
import { Decimal } from "@app/core/money";
import { readCanonicalMoney } from "@app/core/moneyFormat";
import { optionalCustomer, type Customer } from "../plugins/auth";
import { constantTimeEqual } from "../auth";
import { errorBody } from "@app/core/errorBody";
import { payView, payState, transactionStatusView } from "./checkout";
import { originOk } from "./cart";

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
  return typeof token === "string" && constantTimeEqual(token, customer.csrf) && originOk(req);
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

/**
 * The client's method token for each rail, and the currency that rail settles
 * in. Single source of truth for both halves of the top-up form's gateway list:
 * the `<token>_enabled` flags the GET already served, and the per-rail floors
 * added by whole-branch review F3.
 *
 * The tokens are the SPA's, not `PaymentMethod`'s — `WalletTopupPage.tsx` and the
 * POST body below both speak "qris"/"binance"/…, so the floors have to be keyed
 * the same way or the page would have to maintain a second mapping to read them.
 */
const TOPUP_RAILS = [
  ["qris", PaymentMethod.TOKOPAY, "IDR"],
  ["paydisini", PaymentMethod.PAYDISINI, "IDR"],
  ["binance", PaymentMethod.BINANCE_INTERNAL, "USDT"],
  ["bybit", PaymentMethod.BYBIT, "USDT"],
  ["bybit_bsc", PaymentMethod.BYBIT_BSC, "USDT"],
  ["nowpayments", PaymentMethod.NOWPAYMENTS, "USDT"],
] as const satisfies readonly (readonly [string, WalletTopupMethod, "IDR" | "USDT"])[];

/**
 * The smallest amount each rail will accept, **in the currency the buyer types**,
 * keyed by the SPA's method token. null = that rail has no floor to clear (or, for
 * a USDT rail with no usable exchange rate, no floor this server can express —
 * those rails are already switched off by the same missing rate, so the page never
 * consults their entry).
 *
 * This is what lets the top-up form stop offering a rail that
 * `finalizeWalletTopupPayment`'s guard would refuse the moment it was picked —
 * the storefront twin of what `offeredTopupRails` does in the bot and of
 * `railsClearingTheTotal` on the product checkout page. The figure is
 * deliberately resolved SERVER-side through `resolveWalletTopupRailFloor` rather
 * than derived in the page from the raw settings: for a USDT rail judged by the
 * shop-wide Rupiah floor the two are different numbers, and re-deriving the
 * conversion (and its round-UP direction) in the client is how the page would end
 * up advertising a figure the guard then refuses.
 */
async function railFloors(fxRate: Decimal | null): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [token, method, currency] of TOPUP_RAILS) {
    if (currency === "USDT" && !fxRate) {
      out[token] = null;
      continue;
    }
    const floor = await resolveWalletTopupRailFloor(prisma, {
      method,
      ...(currency === "IDR" ? ({ currency: "IDR" } as const) : ({ currency: "USDT", rate: fxRate! } as const)),
    });
    out[token] = floor ? floor.toString() : null;
  }
  return out;
}

/**
 * The minimum the form should ADVERTISE for `currency` (whole-branch review F4b):
 * `max(wallet_topup_min_amount_*, the lowest floor among the rails on offer)`,
 * or null when neither exists.
 *
 * `web.wallet_topup_min_hint` used to read `min_idr`/`min_usdt` alone, so a shop
 * with a Rp10.000 rail floor and a Rp1.000 top-up bound printed "Minimum Rp1.000"
 * and then refused the buyer at Rp5.000 — the form and the guard quoting different
 * figures on consecutive screens.
 *
 * `enabledTokens` matters: a floor belonging to a rail this shop has not
 * configured is not a floor this buyer can hit, and folding it in would advertise
 * a minimum higher than anything that can actually refuse them.
 */
async function effectiveMin(
  currency: "IDR" | "USDT",
  fxRate: Decimal | null,
  enabledTokens: ReadonlySet<string>,
): Promise<Decimal | null> {
  const methods = TOPUP_RAILS.filter(
    ([token, , railCurrency]) => railCurrency === currency && enabledTokens.has(token),
  ).map(([, method]) => method);
  // No rate means no USDT rail is on offer, so `methods` is empty and the rail
  // side is vacuous — the rate below is only there to satisfy the signature.
  const query =
    currency === "IDR" ? ({ currency: "IDR" } as const) : ({ currency: "USDT", rate: fxRate ?? 1 } as const);
  return resolveWalletTopupEffectiveMin(prisma, { ...query, methods });
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
    const enabled: Record<string, boolean> = {
      qris: Boolean(tokopay),
      paydisini: Boolean(paydisini),
      binance: haveRate && binance.enabled,
      bybit: haveRate && bybit.enabled,
      bybit_bsc: haveRate && bybitBsc.enabled,
      nowpayments: haveRate && Boolean(nowpayments),
    };
    const enabledTokens = new Set(Object.keys(enabled).filter((token) => enabled[token]));
    const [minIdr, minUsdt] = await Promise.all([
      effectiveMin("IDR", fxRate, enabledTokens),
      effectiveMin("USDT", fxRate, enabledTokens),
    ]);

    return reply.send({
      idr_enabled: enabled.qris,
      paydisini_enabled: enabled.paydisini,
      binance_enabled: enabled.binance,
      bybit_enabled: enabled.bybit,
      bybit_bsc_enabled: enabled.bybit_bsc,
      nowpayments_enabled: enabled.nowpayments,
      // The raw top-up bounds, as configured. `min_*` is NOT what the form
      // advertises — see `effective_min_*` below — and is kept in the payload
      // because it is the input that figure is derived from, which is what makes
      // a surprising advertised minimum diagnosable from the response alone.
      min_idr: limits.minIdr ? limits.minIdr.toString() : null,
      max_idr: limits.maxIdr ? limits.maxIdr.toString() : null,
      min_usdt: limits.minUsdt ? limits.minUsdt.toString() : null,
      max_usdt: limits.maxUsdt ? limits.maxUsdt.toString() : null,
      // Per-rail floors (F3): what each gateway itself will accept, so the form
      // can drop a rail the typed amount cannot be paid through instead of
      // offering it and having the create call refuse it.
      rail_min: await railFloors(fxRate),
      // The minimum to SHOW and to validate against (F4b): the top-up bound and
      // the rail floors fold into one figure, so the form can never advertise a
      // number the create call would refuse.
      effective_min_idr: minIdr ? minIdr.toString() : null,
      effective_min_usdt: minUsdt ? minUsdt.toString() : null,
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
    if (checkoutSubmitRateLimited(clientIp(req))) return reply.header("Retry-After", "60").code(429).send({ error: "error.rate_limited" });

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

    // The form reads the typed text by shape in the browser
    // (normalizeMoneyInput) and sends the canonical plain decimal it produced,
    // so the wire value is read exactly as that format and nothing else:
    // unreadable text, `1e3`, signs or a typed spelling like `10.000` are a
    // 400, never a DecimalError 500 or a silent misread. Precision and the
    // hard ceiling are judged by createWalletTopupOrder (walletTopupAmountError).
    const amount = readCanonicalMoney((req.body as { amount?: unknown } | undefined)?.amount);
    if (amount === null) return reply.code(400).send({ error: "error.wallet_topup_amount_invalid" });

    try {
      const order = await prisma.$transaction((tx) =>
        createWalletTopupOrder(tx, {
          userId: customer.userId,
          amount,
          currency: choice.currency,
          method: choice.method,
          ...(choice.currency === "USDT" ? { rate: choice.rate } : {}),
        }),
      );
      return reply.code(201).send({ orderCode: order.orderCode });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(400).send(errorBody(e));
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
    return reply.send({ state, ...await transactionStatusView(order), redirect: state === "delivered" ? "/account" : null });
  });

  // ---- Buyer cancels a still-pending top-up ----
  app.post<{ Params: { code: string } }>("/wallet/topup/:code/cancel", async (req, reply) => {
    const customer = await requireCustomer(req, reply);
    if (!customer) return;
    if (!csrfHeaderOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });
    const order = await loadOwnedTopup(req.params.code, customer);
    if (!order) return reply.code(404).send({ error: "not_found" });
    try {
      await prisma.$transaction((tx) =>
        cancelOrder(tx, order.id, "user_cancelled", {
          type: StockActorType.CUSTOMER,
          customerId: customer.userId,
        }),
      );
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e; // already paid/delivered → just bounce
    }
    return reply.send({ ok: true });
  });
};

export default apiWalletTopupRoutes;
import { checkoutSubmitRateLimited, clientIp } from "../rateLimit";
