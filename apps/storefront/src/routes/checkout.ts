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
import { formatIdr, formatPrice } from "@app/core/formatters";
import {
  prisma,
  getCart,
  getBulkPricingForDenomination,
  getVoucherByCode,
  applyVoucherToSubtotal,
  computeBulkDiscountForCart,
  createOrderFromCart,
  applyUsdtWalletToOrder,
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
  resolveBybitBscConfig,
  resolveBinanceInternalConfig,
  getPaydisiniCreds,
  deliverPaidPaydisiniOrder,
  recordUnmatchedPaydisiniTx,
  getNowpaymentsCreds,
  deliverPaidNowpaymentsOrder,
  recordUnmatchedNowpaymentsTx,
} from "@app/db";
import { currentCustomer, csrfProtect, type Customer } from "../plugins/auth";
import { clientIp, webhookRateLimited } from "../rateLimit";
import { createTransaction, verifyCallback, checkTransaction, type TokopayOrderInfo } from "@app/core/payments/tokopay";
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
import { nudgeOutboxDispatcher } from "@app/core/nudge";
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
  const [totals, fxRate, tokopay, bybit, bybitBsc, binance, paydisini, nowpayments] = await Promise.all([
    computeTotals(customer, voucherCode),
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
    resolveBybitBscConfig(prisma),
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
    bybit_bsc_enabled: haveRate && bybitBsc.enabled,
    idr_enabled: Boolean(tokopay),
    paydisini_enabled: Boolean(paydisini),
    nowpayments_enabled: haveRate && Boolean(nowpayments),
    wallet_idr: new Decimal(customer.user.walletBalance).toString(),
    wallet_usdt: new Decimal(customer.user.walletBalanceUsdt).toString(),
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
  if (
    order.status === OrderStatus.PENDING_VERIFICATION ||
    order.status === OrderStatus.PAID ||
    // Bybit BSC in-flight states (deposit seen / confirming on-chain / fully
    // confirmed) — without these, a live Bybit BSC order would fall into the
    // "closed" catch-all below and render as dead the moment a deposit is
    // first detected.
    order.status === OrderStatus.PAYMENT_DETECTED ||
    order.status === OrderStatus.CONFIRMING ||
    order.status === OrderStatus.CONFIRMED
  )
    return "confirming";
  if (order.status === OrderStatus.PENDING_PAYMENT) return expired ? "expired" : "waiting";
  return "closed"; // cancelled / rejected / refunded / underpaid / failed
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
  useWalletIdr = false,
  useWalletUsdt = false,
): Promise<{ orderCode: string }> {
  const [fxRate, tokopay, bybit, bybitBsc, binance, paydisini, nowpayments] = await Promise.all([
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
    resolveBybitBscConfig(prisma),
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
        method:
          | typeof PaymentMethod.BINANCE_INTERNAL
          | typeof PaymentMethod.BYBIT
          | typeof PaymentMethod.BYBIT_BSC
          | typeof PaymentMethod.NOWPAYMENTS;
      }
    | { currency: typeof OrderCurrency.IDR; method?: typeof PaymentMethod.PAYDISINI };
  let choice: Choice;
  if (method === "binance") {
    if (!fxRate || !binance.enabled) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BINANCE_INTERNAL };
  } else if (method === "bybit") {
    if (!fxRate || !bybit.enabled) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT };
  } else if (method === "bybit_bsc") {
    if (!fxRate || !bybitBsc.enabled) throw new ValidationError("web.pay_method_unavailable");
    choice = { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT_BSC };
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

  const isUsdtMethod = choice.currency === OrderCurrency.USDT;
  const walletAmountIdr = useWalletIdr && !isUsdtMethod ? customer.user.walletBalance : 0;
  const walletAmountUsdt = useWalletUsdt && isUsdtMethod ? customer.user.walletBalanceUsdt : undefined;

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
      walletAmount: walletAmountIdr,
    });
    if (!created) throw new ValidationError("error.generic");
    const finalized = await finalizeOrderPayment(tx, created.id, choice);
    if (walletAmountUsdt != null) await applyUsdtWalletToOrder(tx, created.id, walletAmountUsdt);
    return walletAmountUsdt != null ? tx.order.findUnique({ where: { id: created.id } }) : finalized;
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
  app.post<{ Body: { method?: string; voucher_code?: string; use_wallet_idr?: string; use_wallet_usdt?: string } }>(
    "/checkout",
    { preHandler: csrfProtect },
    async (req, reply) => {
      const customer = req.customer!;
      const method = (req.body.method ?? "").toLowerCase();
      const voucherCode = (req.body.voucher_code ?? "").trim().toUpperCase() || null;
      const useWalletIdr = req.body.use_wallet_idr === "1";
      const useWalletUsdt = req.body.use_wallet_usdt === "1";

      const rerender = async (errorKey: string) => {
        const ctx = await shopContext(req, "/cart");
        const view = await checkoutView(customer, voucherCode, errorKey);
        return reply.code(400).view("checkout.njk", { ...ctx, ...view });
      };

      try {
        const { orderCode } = await performCheckout(customer, method, voucherCode, useWalletIdr, useWalletUsdt);
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
      const method = order.paymentMethod; // "BINANCE_INTERNAL" | "BYBIT" | "BYBIT_BSC" | "TOKOPAY" | "PAYDISINI" | "NOWPAYMENTS" | ...
      const isBinance = method === PaymentMethod.BINANCE_INTERNAL;
      const isBybit = method === PaymentMethod.BYBIT;
      const isBybitBsc = method === PaymentMethod.BYBIT_BSC;
      const isQris = method === PaymentMethod.TOKOPAY;
      const isPaydisini = method === PaymentMethod.PAYDISINI;
      const isNowpayments = method === PaymentMethod.NOWPAYMENTS;

      // Bybit UID / BSC deposit address (no API call — just the configured values).
      const bybitCfg = isBybit ? await resolveBybitConfig(prisma) : null;
      const bybitBscCfg = isBybitBsc ? await resolveBybitBscConfig(prisma) : null;
      const binanceCfg = isBinance ? await resolveBinanceInternalConfig(prisma) : null;
      const bybitUid = bybitCfg?.uid ?? "";
      const bybitBscAddress = bybitBscCfg?.depositAddress ?? "";
      const binanceUid = binanceCfg?.receiveUid ?? "";

      // Per-method minimum-payment note (web-admin Settings, blank = none) —
      // pre-formatted here (currency differs by method) rather than pushed
      // into the template. Only resolved while the payment card is actually
      // shown ("waiting"); IDR methods' creds are fetched below alongside
      // their gateway transaction, reused here instead of a second lookup.
      let minAmount: Decimal | null = bybitCfg?.minAmount ?? bybitBscCfg?.minAmount ?? binanceCfg?.minAmount ?? null;

      // TokoPay transaction (QR / pay link) only while actually payable.
      // The result is cached in order.paymentRef (JSON) after the first fetch so
      // that page refreshes don't create extra transactions in TokoPay. Tagged
      // with `gateway: "tokopay"` since PayDisini below caches into the SAME
      // column — see the CachedGateway doc comment above parseCachedGateway.
      let gateway: TokopayOrderInfo | null = null;
      let gatewayError = false;
      if (isQris && state === "waiting") {
        gateway = parseCachedGateway(order.paymentRef);
        const creds = await getTokopayCreds(prisma);
        minAmount = creds?.minAmount ?? null;
        if (!gateway) {
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
              logger.error({ err }, `Failed to create a TokoPay transaction for order ${order.orderCode} — showing the contact fallback instead of a QR code`);
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
        const creds = await getPaydisiniCreds(prisma);
        minAmount = creds?.minAmount ?? null;
        if (!paydisiniGateway) {
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
              logger.error({ err }, `Failed to create a PayDisini transaction for order ${order.orderCode} — showing the contact fallback instead of a QR code`);
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
        const creds = await getNowpaymentsCreds(prisma);
        minAmount = creds?.minAmount ?? null;
        if (!nowpaymentsGateway) {
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
              logger.error({ err }, `Failed to create a NOWPayments invoice for order ${order.orderCode} — showing the contact fallback instead of a payment link`);
              nowpaymentsGatewayError = true;
            }
          } else {
            logger.warn(
              `Cannot create a NOWPayments invoice for order ${order.orderCode} — ${
                !creds ? "no NOWPayments credentials configured" : "no public URL configured (SHOP_PUBLIC_URL/PUBLIC_URL)"
              }, showing the contact fallback instead`,
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

      // Pre-formatted here (not in the template) since IDR vs USDT formatting
      // differs per method — null when unset, so pay.njk just renders the
      // note iff this is non-empty.
      const minAmountDisplay = minAmount
        ? isQris || isPaydisini
          ? formatIdr(minAmount)
          : formatPrice(minAmount, "USDT", 4)
        : null;

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
        is_bybit_bsc: isBybitBsc,
        is_qris: isQris,
        is_paydisini: isPaydisini,
        is_nowpayments: isNowpayments,
        bybit_uid: bybitUid,
        bybit_bsc_address: bybitBscAddress,
        binance_uid: binanceUid,
        gateway,
        gateway_error: gatewayError,
        paydisini_gateway: paydisiniGateway,
        paydisini_gateway_error: paydisiniGatewayError,
        nowpayments_gateway: nowpaymentsGateway,
        nowpayments_gateway_error: nowpaymentsGatewayError,
        min_amount: minAmountDisplay,
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
  //
  // The TokoPay signature is md5(merchantId:secret:refId) — it does NOT cover
  // amount/status (see the ⚠ ASSUMPTION note in @app/core/payments/tokopay),
  // so a body claiming any `nominal`/`status` would otherwise pass as long as
  // the signature for that `refId` is valid. Defense-in-depth: re-confirm the
  // payment live against TokoPay's API (`checkTransaction`, which requires the
  // merchant secret to call) before trusting "paid" or using the amount for
  // delivery — a forged callback body can't fake that server-to-server call.
  app.post("/pay/tokopay/callback", async (req, reply) => {
    // Public + unauthenticated until the signature check below runs — a flood
    // of forged bodies still costs a parse + signature compute (and, on a
    // lucky refId guess, a DB query) before being rejected (Payment-3 fix,
    // security audit 2026-06-23).
    if (webhookRateLimited("tokopay", clientIp(req))) return reply.code(429).send({ status: "rate limited" });

    const creds = await getTokopayCreds(prisma);
    if (!creds) return reply.code(403).send({ status: "disabled" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cb = verifyCallback(body, creds);
    if (!cb) return reply.code(403).send({ status: "bad signature" });
    if (!cb.paid) return reply.send({ status: "ignored" }); // pending/failed callbacks

    const order = await getOrderByCode(prisma, cb.refId);
    // paymentMethod implies currency (finalizeOrderPayment always stamps them
    // together), but cross-check currency explicitly so a future bug that
    // decouples them can never let a TokoPay (IDR) callback amount be
    // compared against a USDT order's total (Payment-4 fix, security audit
    // 2026-06-23).
    if (!order || order.paymentMethod !== PaymentMethod.TOKOPAY || order.currency !== OrderCurrency.IDR) {
      await recordUnmatchedTokopayTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "unmatched" });
    }

    let live;
    try {
      live = await checkTransaction(creds, { refId: cb.refId, amountIdr: order.totalAmount });
    } catch (err) {
      logger.error({ err }, `Failed to check TokoPay's live transaction status for order ${order.orderCode} — the callback will be ignored until a retry confirms payment`);
      return reply.send({ status: "status check failed" });
    }
    if (!live.paid) {
      logger.warn(`TokoPay callback claimed paid but live status check disagrees for ${order.orderCode}`);
      return reply.send({ status: "not confirmed live" });
    }
    // Amount sanity: never deliver on a short payment. Trust the LIVE amount
    // from checkTransaction, not the unsigned callback body field.
    if (live.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `TokoPay callback for order ${order.orderCode} is short-paid — got ${live.amount.toString()}, expected ${order.totalAmount.toString()} — recording it as unmatched instead of delivering`,
      );
      await recordUnmatchedTokopayTx(prisma, { trxId: live.trxId ?? cb.trxId, amount: live.amount });
      return reply.send({ status: "amount mismatch" });
    }

    try {
      const r = await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: live.trxId ?? cb.trxId,
        amount: live.amount,
        shopUrl: shopPublicUrl(),
      });
      if (r.status === "delivered") nudgeOutboxDispatcher();
      return reply.send({ status: r.status });
    } catch (err) {
      logger.error({ err }, `Failed to deliver paid TokoPay order ${order.orderCode} — flagging the ledger row delivery_failed for an admin to resolve from the orders panel`);
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
    // Payment-3 fix, security audit 2026-06-23 — see the TokoPay callback above.
    if (webhookRateLimited("paydisini", clientIp(req))) return reply.code(429).send({ status: "rate limited" });

    const creds = await getPaydisiniCreds(prisma);
    if (!creds) return reply.code(403).send({ status: "disabled" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cb = verifyPaydisiniCallback(body, creds);
    if (!cb) return reply.code(403).send({ status: "bad signature" });
    if (!cb.paid) return reply.send({ status: "ignored" }); // pending/failed callbacks

    const order = await getOrderByCode(prisma, cb.refId);
    // Payment-4 fix, security audit 2026-06-23 — see the TokoPay callback above.
    if (!order || order.paymentMethod !== PaymentMethod.PAYDISINI || order.currency !== OrderCurrency.IDR) {
      await recordUnmatchedPaydisiniTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "unmatched" });
    }
    // Amount sanity: never deliver on a short payment.
    if (cb.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `PayDisini callback for order ${order.orderCode} is short-paid — got ${cb.amount.toString()}, expected ${order.totalAmount.toString()} — recording it as unmatched instead of delivering`,
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
      if (r.status === "delivered") nudgeOutboxDispatcher();
      return reply.send({ status: r.status });
    } catch (err) {
      logger.error({ err }, `Failed to deliver paid PayDisini order ${order.orderCode} — flagging the ledger row delivery_failed for an admin to resolve from the orders panel`);
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
    // Payment-3 fix, security audit 2026-06-23 — see the TokoPay callback above.
    if (webhookRateLimited("nowpayments", clientIp(req))) return reply.code(429).send({ status: "rate limited" });

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
    // Payment-4 fix, security audit 2026-06-23 — see the TokoPay callback above.
    if (!order || order.paymentMethod !== PaymentMethod.NOWPAYMENTS || order.currency !== OrderCurrency.USDT) {
      await recordUnmatchedNowpaymentsTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      return reply.send({ status: "unmatched" });
    }
    // Amount sanity: never deliver on a short/partial payment.
    if (cb.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `NOWPayments callback for order ${order.orderCode} is short-paid — got ${cb.amount.toString()}, expected ${order.totalAmount.toString()} — recording it as unmatched instead of delivering`,
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
      if (r.status === "delivered") nudgeOutboxDispatcher();
      return reply.send({ status: r.status });
    } catch (err) {
      logger.error({ err }, `Failed to deliver paid NOWPayments order ${order.orderCode} — flagging the ledger row delivery_failed for an admin to resolve from the orders panel`);
      // 200 so NOWPayments stops retrying — the ledger row is flagged delivery_failed
      // and an admin resolves it from the orders panel.
      return reply.send({ status: "delivery failed" });
    }
  });
};

export default checkoutRoutes;
