/**
 * Checkout + payment (plan.md §15, §17.1): the buyer picks the payment method
 * at PAY time and that choice fixes the order currency —
 *   USDT → Binance Internal Transfer (UID + unique note), auto-confirmed by
 *          the existing poller;
 *   IDR  → TokoPay (QRIS), auto-confirmed by the webhook callback below.
 * Web is auto-confirm ONLY (no manual proof upload — §17.1 #1) and never
 * touches the wallet (§17.1 #5). Orders are created through the SAME crud as
 * the bot inside one $transaction, so stock checks, vouchers, bulk pricing and
 * unique cents stay consistent across both fronts.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { OrderCurrency, OrderStatus, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { t } from "@app/core/i18n";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import {
  prisma,
  getCart,
  getBulkPricingForDenomination,
  getVoucherByCode,
  applyVoucherToSubtotal,
  computeBulkDiscountForCart,
  createOrderFromCart,
  finalizeOrderPayment,
  getUsdIdrRate,
  getOrderByCode,
  cancelOrder,
  countUserPendingOrders,
  deliverPaidTokopayOrder,
  recordUnmatchedTokopayTx,
  getSetting,
  getTokopayCreds,
  resolveBybitConfig,
  resolveBinanceInternalConfig,
  getPaydisiniCreds,
  deliverPaidPaydisiniOrder,
  recordUnmatchedPaydisiniTx,
  getNowpaymentsCreds,
  deliverPaidNowpaymentsOrder,
  recordUnmatchedNowpaymentsTx,
} from "@app/db";
import { currentCustomer, csrfProtect, type Customer } from "../plugins/auth";
import { createTransaction, verifyCallback, type TokopayOrderInfo } from "@app/core/payments/tokopay";
import {
  createTransaction as createPaydisiniTransaction,
  verifyCallback as verifyPaydisiniCallback,
  type PaydisiniOrderInfo,
} from "@app/core/payments/paydisini";
import {
  createInvoice as createNowpaymentsInvoice,
  verifyIpn,
  type NowpaymentsInvoice,
} from "@app/core/payments/nowpayments";
import { usdtFromIdr } from "../pricing";
import { shopContext, requestLang, resolveBotUsername } from "../shop";
import { loadCartLines } from "./cart";

const MAX_PENDING_ORDERS = 10;

type OrderRow = NonNullable<Awaited<ReturnType<typeof getOrderByCode>>>;

/** Public origin used in buyer DM links (outbox) — storefront URL wins. */
const shopPublicUrl = (): string | null =>
  config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;

/** Totals preview for the checkout page (mirrors createOrderFromCart math). */
async function computeTotals(customer: Customer, voucherCode: string | null) {
  const cart = await getCart(prisma, customer.userId);
  const isReseller = customer.user.role === "RESELLER";
  let subtotal = new Decimal(0);
  const lines = cart.filter((ci) => ci.product.isActive);
  for (const ci of lines) {
    const unit = new Decimal(
      isReseller && ci.product.resellerPrice != null ? ci.product.resellerPrice : ci.product.price,
    );
    subtotal = subtotal.plus(unit.times(ci.quantity));
  }
  const bulkRules: Record<number, { minQuantity: number; discountPercent: Decimal.Value }> = {};
  for (const ci of lines) {
    const rule = await getBulkPricingForDenomination(prisma, ci.productId);
    if (rule) bulkRules[ci.productId] = rule;
  }
  const bulkDiscount = computeBulkDiscountForCart(
    lines as Parameters<typeof computeBulkDiscountForCart>[0],
    bulkRules,
    isReseller,
  );

  let voucherDiscount = new Decimal(0);
  let voucherError: string | null = null;
  if (voucherCode) {
    const voucher = await getVoucherByCode(prisma, voucherCode);
    if (!voucher) {
      voucherError = "error.voucher_not_found";
    } else {
      try {
        voucherDiscount = applyVoucherToSubtotal(voucher, subtotal);
      } catch (e) {
        if (e instanceof ValidationError) voucherError = e.key;
        else throw e;
      }
    }
  }
  const total = Decimal.max(new Decimal(0), subtotal.minus(bulkDiscount).minus(voucherDiscount));
  return { empty: lines.length === 0, subtotal, bulkDiscount, voucherDiscount, voucherError, total };
}

/** View context shared by GET /checkout and the failed-POST re-render. */
async function checkoutView(
  customer: Customer,
  voucherCode: string | null,
  errorKey: string | null,
) {
  const [totals, fxRate, tokopay, bybit, binance, paydisini, nowpayments] = await Promise.all([
    computeTotals(customer, voucherCode),
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
    resolveBinanceInternalConfig(prisma),
    getPaydisiniCreds(prisma),
    getNowpaymentsCreds(prisma),
  ]);
  const haveRate = Boolean(fxRate);
  return {
    items_empty: totals.empty,
    subtotal: totals.subtotal.toString(),
    bulk_discount: totals.bulkDiscount.toString(),
    voucher_discount: totals.voucherDiscount.toString(),
    total: totals.total.toString(),
    total_usdt: fxRate ? usdtFromIdr(totals.total, fxRate).toString() : null,
    voucher_code: voucherCode ?? "",
    error_key: errorKey ?? totals.voucherError,
    binance_enabled: haveRate && binance.enabled,
    bybit_enabled: haveRate && bybit.enabled,
    idr_enabled: Boolean(tokopay),
    paydisini_enabled: Boolean(paydisini),
    nowpayments_enabled: haveRate && Boolean(nowpayments),
  };
}

/**
 * Cached gateway payload shape stored as JSON in order.paymentRef, tagged with
 * a `gateway` discriminator. TokoPay, PayDisini and NOWPayments are three
 * independent payment options that share this single column (plan.md §15 —
 * additive, not exclusive), so a page refresh must be able to tell which
 * gateway's JSON it is looking at without relying solely on
 * order.paymentMethod (kept anyway as the primary signal — the tag is a
 * defensive cross-check / future-proofing). NOWPayments' reconcile poller
 * (apps/order-bot/src/payments/nowpaymentsReconcile.ts `extractInvoiceId`)
 * reads this SAME tagged JSON, so the `gateway: "nowpayments"` tag is a hard
 * contract, not optional — omitting it breaks the poller silently.
 */
type CachedGateway =
  | ({ gateway: "tokopay" } & Record<string, unknown>)
  | ({ gateway: "paydisini" } & Record<string, unknown>)
  | ({ gateway: "nowpayments" } & Record<string, unknown>);

/** Shared JSON.parse + shape guard for the cached-gateway parsers below. */
function parseCachedGatewayJson(paymentRef: string | null): CachedGateway | null {
  if (!paymentRef || !paymentRef.startsWith("{")) return null;
  try {
    const d = JSON.parse(paymentRef) as Record<string, unknown>;
    if (d.gateway !== "tokopay" && d.gateway !== "paydisini" && d.gateway !== "nowpayments") return null;
    return d as CachedGateway;
  } catch {
    return null;
  }
}

/**
 * Parse a cached TokoPay gateway payload stored as JSON in order.paymentRef.
 * Returns null when paymentRef is absent or not a JSON object (e.g. it holds a
 * Binance payment note instead), or when the cached gateway tag doesn't match
 * TokoPay (e.g. a PayDisini payload left over from a different method).
 */
function parseCachedGateway(paymentRef: string | null): TokopayOrderInfo | null {
  const d = parseCachedGatewayJson(paymentRef);
  if (!d || d.gateway !== "tokopay") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  if (typeof d.trxId !== "string") return null;
  return { trxId: d.trxId, payUrl: str(d.payUrl), qrLink: str(d.qrLink), qrString: str(d.qrString), totalBayar: str(d.totalBayar) };
}

/**
 * Parse a cached PayDisini gateway payload stored as JSON in order.paymentRef.
 * Mirrors parseCachedGateway (TokoPay) above — see CachedGateway doc comment
 * for why the discriminator tag exists.
 */
function parseCachedPaydisiniGateway(paymentRef: string | null): PaydisiniOrderInfo | null {
  const d = parseCachedGatewayJson(paymentRef);
  if (!d || d.gateway !== "paydisini") return null;
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  if (typeof d.trxId !== "string") return null;
  return {
    trxId: d.trxId,
    qrString: str(d.qrString),
    qrUrl: str(d.qrUrl),
    checkoutUrl: str(d.checkoutUrl),
    totalBayar: str(d.totalBayar),
  };
}

/**
 * Parse a cached NOWPayments gateway payload stored as JSON in
 * order.paymentRef. Mirrors parseCachedGateway (TokoPay) /
 * parseCachedPaydisiniGateway above — see CachedGateway doc comment for why
 * the discriminator tag exists (here it's a HARD requirement: the bot's
 * NOWPayments reconcile poller reads this same tagged JSON to extract the
 * invoice id — apps/order-bot/src/payments/nowpaymentsReconcile.ts).
 */
function parseCachedNowpaymentsGateway(paymentRef: string | null): NowpaymentsInvoice | null {
  const d = parseCachedGatewayJson(paymentRef);
  if (!d || d.gateway !== "nowpayments") return null;
  if (typeof d.invoiceId !== "string" || !d.invoiceId) return null;
  if (typeof d.invoiceUrl !== "string" || !d.invoiceUrl) return null;
  return { invoiceId: d.invoiceId, invoiceUrl: d.invoiceUrl };
}

/** Status → step + i18n key for the pay page / polling partial. */
function payState(order: OrderRow) {
  const expired =
    order.status === OrderStatus.PENDING_PAYMENT &&
    order.expiresAt != null &&
    ensureUtc(order.expiresAt).toMillis() <= Date.now();
  if (order.status === OrderStatus.DELIVERED) return "delivered";
  if (order.status === OrderStatus.PENDING_VERIFICATION || order.status === OrderStatus.PAID)
    return "confirming";
  if (order.status === OrderStatus.PENDING_PAYMENT) return expired ? "expired" : "waiting";
  return "closed"; // cancelled / rejected / refunded / underpaid
}

/**
 * Validate the chosen payment method, then run the order-creation transaction
 * (countUserPendingOrders → createOrderFromCart → finalizeOrderPayment) — the
 * SAME logic the HTML POST /checkout route and the JSON API's POST /checkout
 * both need, so there is exactly one implementation of checkout's business
 * rules. Throws ValidationError (unavailable method, too many pending orders,
 * generic failure) exactly as the inline code used to.
 */
export async function performCheckout(
  customer: Customer,
  method: string,
  voucherCode: string | null,
): Promise<{ orderCode: string }> {
  const [fxRate, tokopay, bybit, binance, paydisini, nowpayments] = await Promise.all([
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
    resolveBinanceInternalConfig(prisma),
    getPaydisiniCreds(prisma),
    getNowpaymentsCreds(prisma),
  ]);

  // Map the chosen method token → (currency, paymentMethod), each gated.
  // Stricter than PaymentChoice: method is required and BINANCE_PAY is excluded (web-only constraint).
  type Choice =
    | {
        currency: typeof OrderCurrency.USDT;
        rate: NonNullable<typeof fxRate>;
        method: typeof PaymentMethod.BINANCE_INTERNAL | typeof PaymentMethod.BYBIT | typeof PaymentMethod.NOWPAYMENTS;
      }
    | { currency: typeof OrderCurrency.IDR; method?: typeof PaymentMethod.PAYDISINI };
  let choice: Choice;
  if (method === "binance") {
    if (!fxRate || !binance.enabled) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BINANCE_INTERNAL };
  } else if (method === "bybit") {
    if (!fxRate || !bybit.enabled) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT };
  } else if (method === "nowpayments") {
    if (!fxRate || !nowpayments) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.NOWPAYMENTS };
  } else if (method === "qris") {
    if (!tokopay) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.IDR };
  } else if (method === "paydisini") {
    if (!paydisini) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.IDR, method: PaymentMethod.PAYDISINI };
  } else {
    throw new ValidationError("web.pay_method_unavailable");
  }

  const order = await prisma.$transaction(async (tx) => {
    if ((await countUserPendingOrders(tx, customer.userId)) >= MAX_PENDING_ORDERS) {
      throw new ValidationError("error.too_many_pending");
    }
    const created = await createOrderFromCart(tx, {
      user: {
        id: customer.userId,
        role: customer.user.role,
        walletBalance: customer.user.walletBalance,
      },
      voucherCode,
      walletAmount: 0, // wallet is hidden on the web (plan.md §17.1 #5)
    });
    if (!created) throw new ValidationError("error.generic");
    return finalizeOrderPayment(tx, created.id, choice);
  });
  return { orderCode: order!.orderCode };
}

const checkoutRoutes: FastifyPluginAsync = async (app) => {
  // ---- Checkout summary + method choice ----
  app.get("/checkout", { preHandler: currentCustomer }, async (req, reply) => {
    const ctx = await shopContext(req, "/cart");
    const view = await checkoutView(req.customer!, null, null);
    if (view.items_empty) return reply.code(303).redirect("/cart");
    return reply.view("checkout.njk", { ...ctx, ...view });
  });

  // ---- Create the order (re-validates everything via the shared crud) ----
  app.post<{ Body: { method?: string; voucher_code?: string } }>(
    "/checkout",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const method = (req.body.method ?? "").toLowerCase();
      const voucherCode = (req.body.voucher_code ?? "").trim().toUpperCase() || null;

      const rerender = async (errorKey: string) => {
        const ctx = await shopContext(req, "/cart");
        const view = await checkoutView(customer, voucherCode, errorKey);
        return reply.code(400).view("checkout.njk", { ...ctx, ...view });
      };

      try {
        const { orderCode } = await performCheckout(customer, method, voucherCode);
        return reply.code(303).redirect(`/checkout/${orderCode}/pay`);
      } catch (e) {
        if (e instanceof ValidationError) return rerender(e.key);
        throw e;
      }
    },
  );

  // ---- Payment instructions (status-aware) ----
  app.get<{ Params: { code: string } }>(
    "/checkout/:code/pay",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const ctx = await shopContext(req, "/cart");
      const order = await getOrderByCode(prisma, req.params.code);
      if (!order || order.userId !== req.customer!.userId) {
        return reply.code(404).view("error.njk", {
          ...ctx,
          status_code: 404,
          message: t("web.not_found", ctx.lang),
        });
      }

      const state = payState(order);
      const method = order.paymentMethod; // "BINANCE_INTERNAL" | "BYBIT" | "TOKOPAY" | "PAYDISINI" | "NOWPAYMENTS" | ...
      const isBinance = method === PaymentMethod.BINANCE_INTERNAL;
      const isBybit = method === PaymentMethod.BYBIT;
      const isQris = method === PaymentMethod.TOKOPAY;
      const isPaydisini = method === PaymentMethod.PAYDISINI;
      const isNowpayments = method === PaymentMethod.NOWPAYMENTS;

      // Bybit UID (no API call — just the configured UID).
      const bybitAddress = isBybit ? (await resolveBybitConfig(prisma)).uid : "";
      const binanceUid = isBinance ? (await resolveBinanceInternalConfig(prisma)).receiveUid : "";

      // TokoPay transaction (QR / pay link) only while actually payable.
      // The result is cached in order.paymentRef (JSON) after the first fetch so
      // that page refreshes don't create extra transactions in TokoPay. Tagged
      // with `gateway: "tokopay"` since PayDisini below caches into the SAME
      // column — see the CachedGateway doc comment above parseCachedGateway.
      let gateway: TokopayOrderInfo | null = null;
      let gatewayError = false;
      if (isQris && state === "waiting") {
        gateway = parseCachedGateway(order.paymentRef);
        if (!gateway) {
          const creds = await getTokopayCreds(prisma);
          if (creds) {
            try {
              gateway = await createTransaction(creds, {
                refId: order.orderCode,
                amountIdr: order.totalAmount,
              });
              await prisma.order.update({
                where: { id: order.id },
                data: { paymentRef: JSON.stringify({ gateway: "tokopay", ...gateway }) },
              });
            } catch (err) {
              logger.error({ err }, `TokoPay create failed for ${order.orderCode}`);
              gatewayError = true;
            }
          } else {
            gatewayError = true;
          }
        }
      }

      // PayDisini transaction (QR / checkout link) — second IDR option,
      // alongside (not replacing) TokoPay above. Same lazy-create + cache
      // pattern, tagged `gateway: "paydisini"` so a page refresh reads back
      // the right branch even though both share order.paymentRef.
      let paydisiniGateway: PaydisiniOrderInfo | null = null;
      let paydisiniGatewayError = false;
      if (isPaydisini && state === "waiting") {
        paydisiniGateway = parseCachedPaydisiniGateway(order.paymentRef);
        if (!paydisiniGateway) {
          const creds = await getPaydisiniCreds(prisma);
          if (creds) {
            try {
              paydisiniGateway = await createPaydisiniTransaction(creds, {
                refId: order.orderCode,
                amountIdr: order.totalAmount,
              });
              await prisma.order.update({
                where: { id: order.id },
                data: { paymentRef: JSON.stringify({ gateway: "paydisini", ...paydisiniGateway }) },
              });
            } catch (err) {
              logger.error({ err }, `PayDisini create failed for ${order.orderCode}`);
              paydisiniGatewayError = true;
            }
          } else {
            paydisiniGatewayError = true;
          }
        }
      }

      // NOWPayments hosted invoice (redirect-UX, not inline QR) — third payment
      // option, USDT branch (not IDR). Same lazy-create + cache pattern as
      // TokoPay/PayDisini above, tagged `gateway: "nowpayments"` so a page
      // refresh reads back the right branch even though all three share
      // order.paymentRef — and so the bot's NOWPayments reconcile poller
      // (apps/order-bot/src/payments/nowpaymentsReconcile.ts) can find the
      // invoice id. order.totalAmount for a NOWPAYMENTS order is ALREADY in
      // USDT (finalizeOrderPayment's USDT branch) — pass it straight through
      // as amountUsd, no second conversion.
      let nowpaymentsGateway: NowpaymentsInvoice | null = null;
      let nowpaymentsGatewayError = false;
      if (isNowpayments && state === "waiting") {
        nowpaymentsGateway = parseCachedNowpaymentsGateway(order.paymentRef);
        if (!nowpaymentsGateway) {
          const creds = await getNowpaymentsCreds(prisma);
          const publicUrl = shopPublicUrl();
          if (creds && publicUrl) {
            try {
              nowpaymentsGateway = await createNowpaymentsInvoice(creds, {
                orderId: order.orderCode,
                amountUsd: order.totalAmount,
                ipnCallbackUrl: `${publicUrl.replace(/\/+$/, "")}/pay/nowpayments/callback`,
              });
              await prisma.order.update({
                where: { id: order.id },
                data: { paymentRef: JSON.stringify({ gateway: "nowpayments", ...nowpaymentsGateway }) },
              });
            } catch (err) {
              logger.error({ err }, `NOWPayments create failed for ${order.orderCode}`);
              nowpaymentsGatewayError = true;
            }
          } else {
            logger.warn(
              `NOWPayments unavailable for ${order.orderCode}: ${
                !creds ? "no creds configured" : "no public URL configured (SHOP_PUBLIC_URL/PUBLIC_URL)"
              }`,
            );
            nowpaymentsGatewayError = true;
          }
        }
      }

      // Contact fallbacks shown when a Rupiah gateway is temporarily down, so
      // a stuck buyer always has a way to reach us instead of a dead red box.
      const waNumber = (gatewayError && isQris) || (paydisiniGatewayError && isPaydisini) || (nowpaymentsGatewayError && isNowpayments)
        ? ((await getSetting(prisma, "support_whatsapp")) ?? "").replace(/[^0-9]/g, "")
        : "";

      return reply.view("pay.njk", {
        ...ctx,
        order: {
          code: order.orderCode,
          status: order.status,
          currency: order.currency,
          total: order.totalAmount.toString(),
          payment_ref: order.paymentRef,
          expires_at_iso: order.expiresAt ? ensureUtc(order.expiresAt).toISO() : null,
        },
        state,
        is_binance: isBinance,
        is_bybit: isBybit,
        is_qris: isQris,
        is_paydisini: isPaydisini,
        is_nowpayments: isNowpayments,
        bybit_address: bybitAddress,
        binance_uid: binanceUid,
        gateway,
        gateway_error: gatewayError,
        paydisini_gateway: paydisiniGateway,
        paydisini_gateway_error: paydisiniGatewayError,
        nowpayments_gateway: nowpaymentsGateway,
        nowpayments_gateway_error: nowpaymentsGatewayError,
        wa_number: waNumber,
        bot_username: await resolveBotUsername(),
      });
    },
  );

  // ---- HTMX status polling partial (every ~5s on the pay page) ----
  app.get<{ Params: { code: string } }>(
    "/checkout/:code/status",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const order = await getOrderByCode(prisma, req.params.code);
      if (!order || order.userId !== req.customer!.userId) {
        return reply.code(404).type("text/plain").send("not found");
      }
      const state = payState(order);
      const lang = requestLang(req);
      // Once delivered, htmx follows HX-Redirect to the credentials page.
      if (state === "delivered") {
        void reply.header("HX-Redirect", `/account/orders/${order.orderCode}`);
      }
      return reply.view("_pay_status.njk", { lang, state, code: order.orderCode });
    },
  );

  // ---- Buyer cancels a still-pending order ----
  app.post<{ Params: { code: string } }>(
    "/checkout/:code/cancel",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const order = await getOrderByCode(prisma, req.params.code);
      if (order && order.userId === req.customer!.userId) {
        try {
          await prisma.$transaction((tx) => cancelOrder(tx, order.id, "user_cancelled"));
        } catch (e) {
          if (!(e instanceof ValidationError)) throw e; // already paid/delivered → just bounce
        }
      }
      return reply.code(303).redirect("/cart");
    },
  );

  // ---- TokoPay webhook (public; signature is the auth — plan.md §15.5) ----
  app.post("/pay/tokopay/callback", async (req, reply) => {
    const creds = await getTokopayCreds(prisma);
    if (!creds) return reply.code(403).send({ status: "disabled" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cb = verifyCallback(body, creds);
    if (!cb) return reply.code(403).send({ status: "bad signature" });
    if (!cb.paid) return reply.send({ status: "ignored" }); // pending/failed callbacks

    const order = await getOrderByCode(prisma, cb.refId);
    if (!order || order.paymentMethod !== PaymentMethod.TOKOPAY) {
      await recordUnmatchedTokopayTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "unmatched" });
    }
    // Amount sanity: never deliver on a short payment.
    if (cb.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `TokoPay callback short-paid ${order.orderCode}: got ${cb.amount.toString()}, expected ${order.totalAmount.toString()}`,
      );
      await recordUnmatchedTokopayTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "amount mismatch" });
    }

    try {
      const r = await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: cb.trxId,
        amount: cb.amount,
        shopUrl: shopPublicUrl(),
      });
      return reply.send({ status: r.status });
    } catch (err) {
      logger.error({ err }, `TokoPay delivery failed for ${order.orderCode}`);
      // 200 so TokoPay stops retrying — the ledger row is flagged delivery_failed
      // and an admin resolves it from the orders panel.
      return reply.send({ status: "delivery failed" });
    }
  });

  // ---- PayDisini webhook (public; signature is the auth — mirrors the
  // TokoPay callback above byte-for-byte except for the gateway identifiers;
  // same response contract so PayDisini stops retrying regardless of outcome:
  // 403 disabled, 403 bad signature, 200 for every other outcome including
  // delivery-failed) ----
  app.post("/pay/paydisini/callback", async (req, reply) => {
    const creds = await getPaydisiniCreds(prisma);
    if (!creds) return reply.code(403).send({ status: "disabled" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cb = verifyPaydisiniCallback(body, creds);
    if (!cb) return reply.code(403).send({ status: "bad signature" });
    if (!cb.paid) return reply.send({ status: "ignored" }); // pending/failed callbacks

    const order = await getOrderByCode(prisma, cb.refId);
    if (!order || order.paymentMethod !== PaymentMethod.PAYDISINI) {
      await recordUnmatchedPaydisiniTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "unmatched" });
    }
    // Amount sanity: never deliver on a short payment.
    if (cb.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `PayDisini callback short-paid ${order.orderCode}: got ${cb.amount.toString()}, expected ${order.totalAmount.toString()}`,
      );
      await recordUnmatchedPaydisiniTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "amount mismatch" });
    }

    try {
      const r = await deliverPaidPaydisiniOrder(prisma, {
        orderId: order.id,
        trxId: cb.trxId,
        amount: cb.amount,
        shopUrl: shopPublicUrl(),
      });
      return reply.send({ status: r.status });
    } catch (err) {
      logger.error({ err }, `PayDisini delivery failed for ${order.orderCode}`);
      // 200 so PayDisini stops retrying — the ledger row is flagged delivery_failed
      // and an admin resolves it from the orders panel.
      return reply.send({ status: "delivery failed" });
    }
  });

  // ---- NOWPayments IPN webhook (public; signature is the auth) — DIFFERS
  // from TokoPay/PayDisini above: the signature arrives via the HTTP header
  // `x-nowpayments-sig`, not a body field, and is HMAC-SHA512 over the
  // recursively-key-sorted body (verifyIpn handles both). `orderId` in the
  // verified result is `order.orderCode` (NOWPayments' `order_id`, set to
  // orderCode when the invoice was created above), so lookup is via
  // getOrderByCode exactly like the other two gateways. Same response
  // contract: 403 disabled, 403 bad signature, 200 for every other outcome
  // (ignored/unmatched/amount mismatch/delivered/delivery-failed) so
  // NOWPayments stops retrying regardless of outcome. ----
  app.post("/pay/nowpayments/callback", async (req, reply) => {
    const creds = await getNowpaymentsCreds(prisma);
    if (!creds) return reply.code(403).send({ status: "disabled" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const sigHeader = req.headers["x-nowpayments-sig"];
    const cb = verifyIpn(body, typeof sigHeader === "string" ? sigHeader : undefined, creds);
    if (!cb) return reply.code(403).send({ status: "bad signature" });
    // Only an EXACT "finished" status is a delivery — every other status
    // (waiting/confirming/confirmed/sending/partially_paid/failed/refunded/
    // expired) is "not ready yet" and ignored, never an error.
    if (!cb.paid) return reply.send({ status: "ignored" });

    const order = await getOrderByCode(prisma, cb.orderId);
    if (!order || order.paymentMethod !== PaymentMethod.NOWPAYMENTS) {
      await recordUnmatchedNowpaymentsTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "unmatched" });
    }
    // Amount sanity: never deliver on a short/partial payment.
    if (cb.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `NOWPayments callback short-paid ${order.orderCode}: got ${cb.amount.toString()}, expected ${order.totalAmount.toString()}`,
      );
      await recordUnmatchedNowpaymentsTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "amount mismatch" });
    }

    try {
      const r = await deliverPaidNowpaymentsOrder(prisma, {
        orderId: order.id,
        trxId: cb.trxId,
        amount: cb.amount,
        shopUrl: shopPublicUrl(),
      });
      return reply.send({ status: r.status });
    } catch (err) {
      logger.error({ err }, `NOWPayments delivery failed for ${order.orderCode}`);
      // 200 so NOWPayments stops retrying — the ledger row is flagged delivery_failed
      // and an admin resolves it from the orders panel.
      return reply.send({ status: "delivery failed" });
    }
  });
};

export default checkoutRoutes;
