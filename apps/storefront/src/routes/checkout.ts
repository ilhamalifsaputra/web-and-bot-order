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
import { config, isBinanceInternalEnabled } from "@app/core/config";
import { botUsername } from "@app/core/runtime";
import { OrderCurrency, OrderStatus, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { t } from "@app/core/i18n";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { ensureUtc } from "@app/core/datetime";
import {
  prisma,
  getCart,
  getBulkPricingForProduct,
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
} from "@app/db";
import { currentCustomer, csrfProtect, type Customer } from "../plugins/auth";
import { createTransaction, verifyCallback, type TokopayOrderInfo } from "@app/core/payments/tokopay";
import { usdtFromIdr } from "../pricing";
import { shopContext, requestLang } from "../shop";
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
    const rule = await getBulkPricingForProduct(prisma, ci.productId);
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
  const [totals, fxRate, tokopay, bybit] = await Promise.all([
    computeTotals(customer, voucherCode),
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
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
    binance_enabled: haveRate && isBinanceInternalEnabled(),
    bybit_enabled: haveRate && bybit.enabled,
    idr_enabled: Boolean(tokopay),
  };
}

/**
 * Parse a cached TokoPay gateway payload stored as JSON in order.paymentRef.
 * Returns null when paymentRef is absent or not a JSON object (e.g. it holds a
 * Binance payment note instead).
 */
function parseCachedGateway(paymentRef: string | null): TokopayOrderInfo | null {
  if (!paymentRef || !paymentRef.startsWith("{")) return null;
  try {
    const d = JSON.parse(paymentRef) as Record<string, unknown>;
    if (typeof d.trxId !== "string") return null;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return { trxId: d.trxId, payUrl: str(d.payUrl), qrLink: str(d.qrLink), qrString: str(d.qrString), totalBayar: str(d.totalBayar) };
  } catch {
    return null;
  }
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

      const [fxRate, tokopay, bybit] = await Promise.all([
        getUsdIdrRate(prisma),
        getTokopayCreds(prisma),
        resolveBybitConfig(prisma),
      ]);

      // Map the chosen method token → (currency, paymentMethod), each gated.
      // Stricter than PaymentChoice: method is required and BINANCE_PAY is excluded (web-only constraint).
      type Choice =
        | {
            currency: typeof OrderCurrency.USDT;
            rate: NonNullable<typeof fxRate>;
            method: typeof PaymentMethod.BINANCE_INTERNAL | typeof PaymentMethod.BYBIT;
          }
        | { currency: typeof OrderCurrency.IDR };
      let choice: Choice;
      if (method === "binance") {
        if (!fxRate || !isBinanceInternalEnabled()) return rerender("web.pay_method_unavailable");
        choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BINANCE_INTERNAL };
      } else if (method === "bybit") {
        if (!fxRate || !bybit.enabled) return rerender("web.pay_method_unavailable");
        choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT };
      } else if (method === "qris") {
        if (!tokopay) return rerender("web.pay_method_unavailable");
        choice = { currency: OrderCurrency.IDR };
      } else {
        return rerender("web.pay_method_unavailable");
      }

      try {
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
        return reply.code(303).redirect(`/checkout/${order!.orderCode}/pay`);
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
      const isUsdt = order.currency === OrderCurrency.USDT;

      // TokoPay transaction (QR / pay link) only while actually payable.
      // The result is cached in order.paymentRef (JSON) after the first fetch so
      // that page refreshes don't create extra transactions in TokoPay.
      let gateway: TokopayOrderInfo | null = null;
      let gatewayError = false;
      if (!isUsdt && state === "waiting") {
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
                data: { paymentRef: JSON.stringify(gateway) },
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

      // Contact fallbacks shown when the Rupiah gateway is temporarily down, so
      // a stuck buyer always has a way to reach us instead of a dead red box.
      const waNumber = gatewayError && !isUsdt
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
        is_usdt: isUsdt,
        binance_uid: config.BINANCE_RECEIVE_UID ?? "",
        gateway,
        gateway_error: gatewayError,
        wa_number: waNumber,
        bot_username: botUsername() ?? "",
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
};

export default checkoutRoutes;
