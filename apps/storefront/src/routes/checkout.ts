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
 *
 * Cluster C cutover (docs/REACT_STOREFRONT_MIGRATION.md): the HTML/HTMX
 * checkout + pay pages are gone — GET /checkout and GET /checkout/:code/pay
 * now fall to the React SPA shell (routes/spaShell.ts), which talks to the
 * JSON twins in routes/apiCheckout.ts + routes/api.ts. This file now exports
 * ONLY the shared business-logic helpers those JSON routes call
 * (checkoutView / performCheckout / payView / payState) and registers the
 * three payment webhooks below — no HTTP routes of its own for the buyer UI.
 */
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { config } from "@app/core/config";
import { DeliveryType, OrderCurrency, OrderStatus, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { parseAdditionalFields, validateCustomerData } from "@app/core/deliveryFields";
import { parseInputFields } from "@app/core/playerInput";
import { logger } from "@app/core/logger";
import { Decimal } from "@app/core/money";
import { canonicalProduct } from "@app/core/canonicalProduct";
import { effectiveUnitPrice, type FlashFields } from "@app/core/flash";
import { bulkDiscountFor } from "@app/core/bulk";
import { ensureUtc } from "@app/core/datetime";
import { formatIdr, formatUsdt } from "@app/core/formatters";
import { cartCompositionError } from "@app/core/cartComposition";
import {
  prisma,
  getCart,
  cartCompositionLineOfCartItem,
  getDenomination,
  getBulkPricingForDenomination,
  getVoucherByCode,
  assertVoucherNotRedeemedByUser,
  applyVoucherToSubtotal,
  computeEligibleAmounts,
  type EligibilityLine,
  computeBulkDiscountForCart,
  createOrderFromCart,
  completeCartOrderWithWalletCredit,
  completeOrderWithWalletCredit,
  settleFullyDiscountedOrder,
  orderHasNothingLeftToCollect,
  orderTotalClearsRailMinimum,
  usdIdrQuoteIsFresh,
  createOrderDirect,
  finalizeOrderPayment,
  getUsdIdrRate,
  getCanonicalRateContext,
  getDenominationWithProduct,
  countAvailableStock,
  getOrderByCode,
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
  enqueueAdminStalePayment,
  enqueueAdminUnconfirmablePayment,
  claimGatewaySlot,
  commitGatewayResult,
  releaseGatewaySlot,
  MAX_CART_ORDER_UNITS,
  getDigiflazzCreds,
  getDigiflazzWebhookSecret,
  fulfillDigiflazzOrder,
  claimDigiflazzWebhookRecheck,
  recordDigiflazzOutcome,
  resolveSingleDigiflazzItem,
  buildDigiflazzCustomerNo,
  triggerDigiflazzDispatch,
} from "@app/db";
import { type Customer } from "../plugins/auth";
import { clientIp, webhookRateLimited } from "../rateLimit";
import {
  createTransaction,
  verifyCallback,
  checkTransaction,
  computeQrisAdminFee,
  qrisChargeAmount,
  type TokopayOrderInfo,
} from "@app/core/payments/tokopay";
import {
  createTransaction as createPaydisiniTransaction,
  verifyCallback as verifyPaydisiniCallback,
  checkTransaction as checkPaydisiniTransaction,
  type PaydisiniOrderInfo,
} from "@app/core/payments/paydisini";
import {
  createInvoice as createNowpaymentsInvoice,
  verifyIpn,
  checkNowpaymentsAmount,
  type NowpaymentsInvoice,
} from "@app/core/payments/nowpayments";
import {
  inspectWebhook as inspectDigiflazzWebhook,
  createTransaction as createDigiflazzTransaction,
  type DigiflazzTransactionResult,
} from "@app/core/suppliers/digiflazz";
import { DigiflazzTimingEvent, elapsedMs, logDigiflazzTimingEvent } from "@app/core/suppliers/digiflazzTiming";
import { gatewayLedgerTrxId } from "@app/core/payments/ledgerKey";
import { nudgeOutboxDispatcher } from "@app/core/nudge";
import { usdtFromIdr } from "../pricing";
import { flashViewFor, loadGuestCartItems } from "./cart";
import { resolveBotUsername, requestLang, requestCurrency, resolveDisplayCurrency } from "../shop";

/** Per-buyer cap on simultaneously unpaid orders. Exported so every
 * order-creating storefront rail enforces the SAME number (the cart-based
 * performCheckout/performWalletCheckout below and the single-denomination
 * instant-buy rails beside them) instead of each keeping a copy that can
 * drift. */
export const MAX_PENDING_ORDERS = 10;

type OrderRow = NonNullable<Awaited<ReturnType<typeof getOrderByCode>>>;

/** Public origin used in buyer DM links (outbox) — storefront URL wins. */
const shopPublicUrl = (): string | null =>
  config.SHOP_PUBLIC_URL ?? config.PUBLIC_URL ?? null;

/**
 * One cart line as computeTotals needs it — either a signed-in buyer's
 * CartItem row (getCart, `product` = the joined Denomination) or a guest
 * cookie line resolved to the same shape (loadGuestCartItems, routes/cart.ts)
 * — only the fields actually read below are required, so both sources
 * satisfy this structurally with no cast.
 */
type CartLine = {
  productId: number;
  quantity: number;
  product: FlashFields & {
    price: Decimal.Value;
    resellerPrice: Decimal.Value | null;
    isActive: boolean;
    deliveryType: string;
    additionalFields: string | null;
    // The Denomination's own FK to the parent catalog Product (voucher scope
    // and bulk-rule lookups match against THIS id, not the Denomination's
    // own id) — both getCart and loadGuestCartItems already select it.
    productId: number;
  };
};

/**
 * One denomination + quantity to price INSTEAD of reading the buyer's cart.
 *
 * The instant-buy flow (apps/storefront/client/src/pages/InstantBuyPage.tsx,
 * the Digiflazz top-up pilot) is a DIRECT purchase: the buyer picks one
 * denomination and pays, and that selection must never enter the cart table —
 * it used to be written there purely so `computeTotals` below could see it,
 * which silently destroyed whatever the visitor already had in their cart
 * (final-review finding N2). Passing the selection here instead means the
 * preview and the order both price the same ad-hoc line with the SAME math
 * the cart path uses, with no cart read and no cart write anywhere.
 */
export type AdHocLine = { denominationId: number; quantity: number };

/**
 * The ad-hoc line resolved into exactly the `CartLine` shape the rest of
 * computeTotals already consumes — a Denomination row structurally satisfies
 * `CartLine["product"]` (same row `getCart`/`loadGuestCartItems` join as
 * `ci.product`), so nothing downstream can tell the difference. An unknown id
 * yields no lines at all, which computeTotals reports as `empty: true` exactly
 * like an empty cart; an INACTIVE one is filtered by the same
 * `ci.product.isActive` filter every cart line goes through.
 */
async function loadAdHocLine(line: AdHocLine): Promise<CartLine[]> {
  const denom = await getDenomination(prisma, line.denominationId);
  if (!denom) return [];
  return [{ productId: denom.id, quantity: line.quantity, product: denom }];
}

/** Totals preview for the checkout page (mirrors createOrderFromCart math).
 * `customer` null means an anonymous visitor — their cart lines come from
 * the guest cookie (loadGuestCartItems) instead of a CartItem query, and
 * they're never a reseller (same assumption loadCartLines' guest branch
 * already makes). Every other step of the math is identical for guests and
 * signed-in buyers — one implementation, per CLAUDE.md.
 *
 * `adHocLine` (optional, and omitted by every cart-based caller) replaces the
 * cart read with one synthetic line — see AdHocLine above. It changes NOTHING
 * else: bulk discount, voucher scope/eligibility, the cap against the
 * bulk-discounted subtotal and the QRIS fee all run on `lines` regardless of
 * where those lines came from, which is what guarantees an instant-buy preview
 * quotes byte-identical numbers to what checkout actually charges. */
async function computeTotals(
  req: FastifyRequest,
  customer: Customer | null,
  voucherCode: string | null,
  adHocLine?: AdHocLine | null,
) {
  const cart: CartLine[] = adHocLine
    ? await loadAdHocLine(adHocLine)
    : customer
      ? await getCart(prisma, customer.userId)
      : await loadGuestCartItems(req);
  const isReseller = customer ? customer.user.role === "RESELLER" : false;
  // Price the whole preview against one instant, mirroring createOrderFromCart
  // — otherwise a flash sale ending mid-request could discount some lines but
  // not others and the preview would not match what checkout actually charges.
  const pricedAt = new Date();
  let subtotal = new Decimal(0);
  const lines = cart.filter((ci) => ci.product.isActive);
  for (const ci of lines) {
    const unit = effectiveUnitPrice(ci.product, isReseller, pricedAt);
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
    pricedAt,
  );

  let voucherDiscount = new Decimal(0);
  let voucherError: string | null = null;
  if (voucherCode) {
    const voucher = await getVoucherByCode(prisma, voucherCode);
    if (!voucher) {
      voucherError = "error.voucher_not_found";
    } else {
      try {
        if (customer) await assertVoucherNotRedeemedByUser(prisma, voucher.id, customer.userId);
        // Mirrors createOrderFromCart's own scope-eligibility computation
        // (packages/db/src/crud/orders.ts) — a SELECTED-scope voucher must
        // quote the SAME discount here as checkout will actually charge, or
        // this preview would show a bigger discount than the buyer gets (or
        // let a voucher look valid here only to be rejected at order
        // creation). ALL-scope (the default) skips straight to
        // eligibleSubtotal = subtotal, byte-identical to the pre-scope preview.
        const eligibilityLines: EligibilityLine[] = lines.map((ci) => {
          const itemSubtotal = effectiveUnitPrice(ci.product, isReseller, pricedAt).times(ci.quantity);
          return {
            catalogProductId: ci.product.productId,
            lineSubtotal: itemSubtotal,
            lineBulkDiscount: bulkDiscountFor(itemSubtotal, bulkRules[ci.productId], ci.quantity),
          };
        });
        const { eligibleSubtotal, eligibleBulkDiscount } = await computeEligibleAmounts(
          prisma,
          voucher,
          eligibilityLines,
          subtotal,
          bulkDiscount,
        );
        // Cap against the subtotal NET of the bulk discount — the exact input
        // createOrderFromCart uses (packages/db/src/crud/orders.ts, the Money-2
        // fix). Capping against the gross subtotal here made this preview quote
        // a bigger discount (and so a smaller total) than checkout actually
        // charged whenever a cart carried both a bulk rule and a percent
        // voucher, and let a voucher pass its minPurchase check on screen only
        // to be rejected at order creation.
        voucherDiscount = applyVoucherToSubtotal(
          voucher,
          subtotal.minus(bulkDiscount),
          eligibleSubtotal.minus(eligibleBulkDiscount),
          pricedAt,
        );
      } catch (e) {
        if (e instanceof ValidationError) voucherError = e.key;
        else throw e;
      }
    }
  }
  const total = Decimal.max(new Decimal(0), subtotal.minus(bulkDiscount).minus(voucherDiscount));
  // QRIS admin fee preview (TokoPay only — @app/core/payments/tokopay is the
  // one place this formula is computed) so the checkout page can show it
  // before the buyer has even picked a payment method. Based on `total` (net
  // of bulk discount/voucher), NOT `subtotal` — TokoPay's nominal (and so its
  // own fee) is computed off the discounted total actually sent to the
  // gateway, never the pre-discount gross (H-1 fix, backend audit 2026-07-31).
  const qrisAdminFee = computeQrisAdminFee(total);
  const qrisGrandTotal = total.plus(qrisAdminFee);
  // `lines` (the already-joined CartItem rows, each with its Denomination via
  // `ci.product`) rides along so checkoutView can build its per-item array
  // without a second cart query.
  // `isReseller`/`pricedAt` ride along too so checkoutView can label the same
  // lines with the flash sale they were actually priced against, rather than
  // re-deriving it against a later instant.
  return {
    empty: lines.length === 0,
    subtotal,
    bulkDiscount,
    voucherDiscount,
    voucherError,
    total,
    qrisAdminFee,
    qrisGrandTotal,
    lines,
    isReseller,
    pricedAt,
  };
}

/** View context shared by GET /checkout, the failed-POST re-render, and the
 * JSON API (routes/apiCheckout.ts) — one totals implementation. `customer`
 * null serves an anonymous visitor (guest checkout, Task 2): their cart comes
 * from the `req` cookie via computeTotals, they have no wallet balance
 * (wallet_idr/wallet_usdt = "0", wallet_idr_enabled/wallet_usdt_enabled =
 * false so the UI never offers a balance payment method with nothing behind
 * it), and `is_guest: true` tells the SPA to collect an email at checkout
 * (a later task). The auth gate on every route calling this stays unchanged
 * — this only makes the view layer *able* to serve a guest.
 *
 * `adHocLine` (optional) is threaded straight through to computeTotals: pass
 * it and this whole response — gateway availability, fx rate, wallet balances,
 * `is_guest`, the per-item delivery/field spec, every total — describes one
 * ad-hoc denomination instead of the buyer's cart, with no cart read at all.
 * That is what makes `POST /api/v1/topup/preview` (routes/apiTopup.ts) a
 * parameter on this one implementation rather than a second, drifting one. */
/** The six gateway rails, with the currency each one settles in. */
const GATEWAY_RAILS = [
  [PaymentMethod.TOKOPAY, OrderCurrency.IDR],
  [PaymentMethod.PAYDISINI, OrderCurrency.IDR],
  [PaymentMethod.BINANCE_INTERNAL, OrderCurrency.USDT],
  [PaymentMethod.BYBIT, OrderCurrency.USDT],
  [PaymentMethod.BYBIT_BSC, OrderCurrency.USDT],
  [PaymentMethod.NOWPAYMENTS, OrderCurrency.USDT],
] as const;

/**
 * Which rails a cart totalling `total` could actually be finalized on, keyed by
 * PaymentMethod (M11). Reads `orderTotalClearsRailMinimum` — the SAME helper
 * the finalize-time guard throws from — so this page can never offer a method
 * that would be refused the moment the buyer picked it.
 *
 * Two deliberate non-filters:
 *  - A total of zero clears nothing, yet needs no rail at all: such an order is
 *    settled from the shop's own books whichever method is submitted
 *    (`settleFullyDiscountedOrder`). Filtering there would hide every option
 *    and strand a buyer whose voucher covered their whole cart — a guest most
 *    of all, since the wallet rows are never offered to one.
 *  - A missing exchange rate leaves the USDT rails' answer to their existing
 *    `haveRate` gate rather than judging them against an amount we cannot
 *    convert.
 *
 * Not affected by whole-branch review D6, and worth saying so because the bot's
 * equivalent needed checking: `total` is the full cart total, and it is also the
 * full amount every gateway rail here will be asked for. The storefront never
 * combines wallet credit with a gateway — `performCheckout` and
 * `performDirectCheckout` deliberately pass no `walletAmount`, and the SPA
 * exposes credit only as an all-or-nothing method of its own that settles
 * without a gateway. So there is no credit that could lower the amount to
 * collect between this list and the finalize-time guard.
 */
async function railsClearingTheTotal(
  total: Decimal,
  fxRate: Awaited<ReturnType<typeof getUsdIdrRate>>,
): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  const nothingToCollect = !total.greaterThan(0);
  for (const [method, currency] of GATEWAY_RAILS) {
    if (nothingToCollect || (currency === OrderCurrency.USDT && !fxRate)) {
      out[method] = true;
      continue;
    }
    out[method] = await orderTotalClearsRailMinimum(prisma, {
      method,
      currency,
      idrAmount: total,
      railAmount: currency === OrderCurrency.IDR ? total : usdtFromIdr(total, fxRate!),
    });
  }
  return out;
}

export async function checkoutView(
  req: FastifyRequest,
  customer: Customer | null,
  voucherCode: string | null,
  errorKey: string | null,
  adHocLine?: AdHocLine | null,
) {
  const [totals, rateContext, tokopay, bybit, bybitBsc, binance, paydisini, nowpayments] = await Promise.all([
    computeTotals(req, customer, voucherCode, adHocLine),
    getCanonicalRateContext(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
    resolveBybitBscConfig(prisma),
    resolveBinanceInternalConfig(prisma),
    getPaydisiniCreds(prisma),
    getNowpaymentsCreds(prisma),
  ]);
  const fxRate = rateContext.rate ? new Decimal(rateContext.rate) : null;
  const display = { ...rateContext, preferredCurrency: resolveDisplayCurrency(customer?.user, requestCurrency(req)) ?? "IDR", locale: requestLang(req), generatedAt: new Date().toISOString() };
  const canonicalItems = await Promise.all(totals.lines.map(async (ci) => {
    const [denom, available] = await Promise.all([getDenominationWithProduct(prisma, ci.productId), countAvailableStock(prisma, ci.productId)]);
    return denom ? canonicalProduct({ denomination: { ...denom, createdAt: denom.createdAt.toISOString() }, product: denom.product, category: denom.product.category, stockAvailable: denom.deliveryType !== DeliveryType.AUTO || available > 0 }, { ...display, effectivePriceIDR: effectiveUnitPrice(ci.product, totals.isReseller, totals.pricedAt).toString() }) : null;
  }));
  const haveRate = Boolean(fxRate);
  // Third condition on every USDT rail, beyond "configured" and "clears the
  // minimum": the saved rate must still be inside its quote lifetime, read
  // through the same helper `finalizeOrderPayment`'s guard throws from. `fxRate`
  // only goes null once `fx_rate_max_age_hours` has passed (two days by
  // default), so between the one-hour quote TTL and that horizon the page used
  // to offer every USDT method and have each one refused with
  // `error.fx_quote_expired` the moment it was submitted.
  //
  // Zero total exempt for the same reason railsClearingTheTotal exempts it: a
  // nothing-left-to-collect cart is settled from the shop's own books and never
  // reaches the guard, so hiding its options would strand the buyer.
  const usdtRailsOfferable =
    haveRate && (!totals.total.greaterThan(0) || (await usdIdrQuoteIsFresh(prisma)));
  const clears = await railsClearingTheTotal(totals.total, fxRate);
  // "Is this rail switched on and usable at all", before the minimums have a say.
  // Kept separate from the flags below so the page can tell the buyer WHICH of
  // two very different things happened: a shop with no working gateway (nothing
  // they can do but wait or ask), or a total under every gateway's floor (which
  // they fix by buying a little more). One "no payment methods, contact support"
  // message for both was wrong half the time.
  const railLive: Record<string, boolean> = {
    [PaymentMethod.TOKOPAY]: Boolean(tokopay),
    [PaymentMethod.PAYDISINI]: Boolean(paydisini),
    [PaymentMethod.BINANCE_INTERNAL]: usdtRailsOfferable && binance.enabled,
    [PaymentMethod.BYBIT]: usdtRailsOfferable && bybit.enabled,
    [PaymentMethod.BYBIT_BSC]: usdtRailsOfferable && bybitBsc.enabled,
    [PaymentMethod.NOWPAYMENTS]: usdtRailsOfferable && Boolean(nowpayments),
  };
  const offered = (method: string) => railLive[method]! && clears[method]!;
  return {
    items_empty: totals.empty,
    // Per-item data (Task 6): the SPA's checkout info-collection step needs
    // delivery_type + the parsed manual_with_info field spec per cart line.
    // Given the single-SKU-per-non-auto-cart guard (routes/api.ts POST
    // /cart), a non-auto cart always has exactly one entry here; an auto cart
    // can have many (irrelevant to the info step).
    items: totals.lines.map((ci, index) => ({
      canonical: canonicalItems[index],
      denomination_id: ci.productId,
      delivery_type: ci.product.deliveryType,
      additional_fields: parseAdditionalFields(ci.product.additionalFields),
      qty: ci.quantity,
      // Live flash sale on this line (null when none), so the summary can mark
      // the discount without the page having to fetch the cart separately.
      flash: flashViewFor(
        ci.product,
        effectiveUnitPrice(ci.product, totals.isReseller, totals.pricedAt),
      ),
    })),
    subtotal: totals.subtotal.toString(),
    bulk_discount: totals.bulkDiscount.toString(),
    voucher_discount: totals.voucherDiscount.toString(),
    total: totals.total.toString(),
    qris_admin_fee: totals.qrisAdminFee.toString(),
    qris_grand_total: totals.qrisGrandTotal.toString(),
    total_usdt: fxRate ? usdtFromIdr(totals.total, fxRate).toString() : null,
    voucher_code: voucherCode ?? "",
    error_key: errorKey ?? totals.voucherError,
    binance_enabled: offered(PaymentMethod.BINANCE_INTERNAL),
    bybit_enabled: offered(PaymentMethod.BYBIT),
    bybit_bsc_enabled: offered(PaymentMethod.BYBIT_BSC),
    idr_enabled: offered(PaymentMethod.TOKOPAY),
    paydisini_enabled: offered(PaymentMethod.PAYDISINI),
    nowpayments_enabled: offered(PaymentMethod.NOWPAYMENTS),
    // Every working gateway was filtered out by a minimum, and only by that:
    // there IS a live rail, the cart is simply too cheap for it. The buyer can
    // act on this, so the page says so instead of sending them to support. False
    // when no rail is live in the first place (nothing to do with the total) and
    // on a zero total (never filtered at all — see railsClearingTheTotal).
    below_all_minimums:
      totals.total.greaterThan(0) &&
      GATEWAY_RAILS.some(([method]) => railLive[method]) &&
      !GATEWAY_RAILS.some(([method]) => offered(method)),
    wallet_idr: customer ? new Decimal(customer.user.walletBalance).toString() : "0",
    wallet_usdt: customer ? new Decimal(customer.user.walletBalanceUsdt).toString() : "0",
    // Balance payment methods are only ever offered to signed-in buyers — a
    // guest has no wallet to pay from (§17.1 #5 never touches the wallet
    // anyway). The route/UI still decides whether the balance is SUFFICIENT;
    // this flag only gates whether the option can appear at all.
    wallet_idr_enabled: customer !== null,
    wallet_usdt_enabled: customer !== null,
    // Tells the SPA to collect a contact email at checkout (Task 3+).
    is_guest: customer === null,
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
export function payState(order: OrderRow) {
  const expired =
    order.status === OrderStatus.PENDING_PAYMENT &&
    order.expiresAt != null &&
    ensureUtc(order.expiresAt).toMillis() <= Date.now();
  if (order.status === OrderStatus.DELIVERED) return "delivered";
  // PROCESSING is already paid and waiting on fulfillment: an automatic
  // top-up being sent (Digiflazz), or a MANUAL / MANUAL_WITH_INFO SKU waiting
  // for an admin to hand-type and send the account. It used to fall into the
  // "closed" catch-all, and then into "confirming", whose copy talks about
  // blockchain confirmation — which made a buyer believe their payment was
  // stuck. It has its own state so the page can say what is really happening.
  if (order.status === OrderStatus.PROCESSING) return "processing";
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
 * The gateway payment choice for one method token, or a thrown
 * `web.pay_method_unavailable`.
 *
 * Map the chosen method token → (currency, paymentMethod), each gated.
 * Stricter than PaymentChoice: method is required and BINANCE_PAY is excluded (web-only constraint).
 *
 * Extracted out of performCheckout (which is its original and still its main
 * caller) so the instant-buy rail below routes a method token through the
 * EXACT same gate list — an option switched off in Settings must be
 * unavailable on both rails, and a new gateway must only ever be added here
 * once. The wallet-credit tokens (`wallet_idr`/`wallet_usdt`) are deliberately
 * NOT in this list: they settle without a gateway and are handled by their own
 * rail (performWalletCheckout / performDirectWalletCheckout).
 */
type GatewayPaymentChoice =
  | {
      currency: typeof OrderCurrency.USDT;
      rate: NonNullable<Awaited<ReturnType<typeof getUsdIdrRate>>>;
      method:
        | typeof PaymentMethod.BINANCE_INTERNAL
        | typeof PaymentMethod.BYBIT
        | typeof PaymentMethod.BYBIT_BSC
        | typeof PaymentMethod.NOWPAYMENTS;
    }
  | { currency: typeof OrderCurrency.IDR; method?: typeof PaymentMethod.PAYDISINI };

async function resolveGatewayPaymentChoice(method: string): Promise<GatewayPaymentChoice> {
  const [fxRate, tokopay, bybit, bybitBsc, binance, paydisini, nowpayments] = await Promise.all([
    getUsdIdrRate(prisma),
    getTokopayCreds(prisma),
    resolveBybitConfig(prisma),
    resolveBybitBscConfig(prisma),
    resolveBinanceInternalConfig(prisma),
    getPaydisiniCreds(prisma),
    getNowpaymentsCreds(prisma),
  ]);

  if (method === "binance") {
    if (!fxRate || !binance.enabled) throw new ValidationError("web.pay_method_unavailable");
    return { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BINANCE_INTERNAL };
  }
  if (method === "bybit") {
    if (!fxRate || !bybit.enabled) throw new ValidationError("web.pay_method_unavailable");
    return { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT };
  }
  if (method === "bybit_bsc") {
    if (!fxRate || !bybitBsc.enabled) throw new ValidationError("web.pay_method_unavailable");
    return { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.BYBIT_BSC };
  }
  if (method === "nowpayments") {
    if (!fxRate || !nowpayments) throw new ValidationError("web.pay_method_unavailable");
    return { currency: OrderCurrency.USDT, rate: fxRate, method: PaymentMethod.NOWPAYMENTS };
  }
  if (method === "qris") {
    if (!tokopay) throw new ValidationError("web.pay_method_unavailable");
    return { currency: OrderCurrency.IDR };
  }
  if (method === "paydisini") {
    if (!paydisini) throw new ValidationError("web.pay_method_unavailable");
    return { currency: OrderCurrency.IDR, method: PaymentMethod.PAYDISINI };
  }
  throw new ValidationError("web.pay_method_unavailable");
}

/**
 * Validate the chosen payment method, then run the order-creation transaction
 * (countUserPendingOrders → createOrderFromCart → finalizeOrderPayment) — the
 * one implementation of checkout's business rules the JSON API's POST
 * /checkout (routes/apiCheckout.ts) calls. Throws ValidationError
 * (unavailable method, too many pending orders, generic failure) exactly as
 * the former inline HTML-route code used to.
 *
 * `settledWithoutGateway` reports which of the two outcomes happened, because
 * they need different next screens: a normal order is waiting to be paid and
 * belongs on the pay page, while a fully-discounted one is already paid and
 * (for an auto SKU) delivered, and belongs on the order page like the
 * wallet-credit siblings below. Sending a settled order to the pay page showed
 * the buyer a payment screen for an order nobody owes anything on.
 */
export async function performCheckout(
  customer: Customer,
  method: string,
  voucherCode: string | null,
  customerData?: unknown,
): Promise<{ orderCode: string; settledWithoutGateway: boolean }> {
  const choice = await resolveGatewayPaymentChoice(method);

  // Fail fast on an over-cap cart BEFORE even opening the write transaction
  // below (M-7 fix, backend audit 2026-07-31) — createOrderFromCart does
  // per-unit stock allocation + an OrderItem insert for every unit in the
  // cart, and doing that for thousands of units inside one $transaction would
  // hold locks and a connection long enough to starve every other writer (the
  // bot, webhooks, delivery transactions) before likely timing out. This is a
  // read against `prisma` directly, outside any transaction, so an over-cap
  // cart never causes a transaction to even start; createOrderFromCart
  // enforces the same cap again once inside the transaction as a
  // defense-in-depth backstop (e.g. for other callers, or a cart that grows
  // between this check and the transaction opening).
  const precheckCart = await getCart(prisma, customer.userId);
  const precheckTotalUnits = precheckCart
    .filter((ci) => ci.product.isActive)
    .reduce((sum, ci) => sum + ci.quantity, 0);
  if (precheckTotalUnits > MAX_CART_ORDER_UNITS) {
    throw new ValidationError("error.cart_too_large", { limit: MAX_CART_ORDER_UNITS });
  }

  const order = await prisma.$transaction(async (tx) => {
    if ((await countUserPendingOrders(tx, customer.userId)) >= MAX_PENDING_ORDERS) {
      throw new ValidationError("error.too_many_pending");
    }

    // Re-assert cart homogeneity at the actual money-moving choke point, not
    // just at add-to-cart (routes/api.ts POST /cart already guards this, but
    // a cart can still end up mixed via the guest-cart-merge-on-login path
    // (routes/auth.ts's establishSession, which upserts via addToCart with no
    // delivery-type awareness) or a theoretical two-tab add race — see the
    // per-SKU delivery flows plan's known-gaps note. Re-checking HERE closes
    // it regardless of how the cart became mixed: updateOrderCustomerData and
    // every order-detail reader (admin + storefront) assume `items[0]`'s
    // denomination speaks for the whole order, which silently breaks (wrong
    // field spec, wrong answer count, or a manual line quietly absorbed into
    // an "auto" order) if that assumption is ever violated.
    const cartLines = await getCart(tx, customer.userId);
    const activeCartLines = cartLines.filter((ci) => ci.product.isActive);
    // Now the shared, named `cart_kind` rule (@app/core/cartComposition)
    // rather than an inline copy of the add-to-cart check — same rule, same
    // error key for every cart a buyer can actually build, just no longer
    // duplicated across three files. Trustance Phase 1 Task 3.
    const compositionError = cartCompositionError(activeCartLines.map(cartCompositionLineOfCartItem));
    if (compositionError) {
      throw new ValidationError(compositionError);
    }

    // Server-side revalidation of the buyer-submitted manual_with_info
    // answers — the client's own validation (CheckoutPage.tsx) is a UX
    // convenience only, never trusted. Per the single-SKU-per-non-auto-cart
    // guard (routes/api.ts POST /cart, re-asserted above), a manual_with_info
    // cart always has exactly one active line; validateCustomerData throws
    // ValidationError (propagated to the route's existing catch) on any
    // missing/invalid answer. auto/manual carts pass customerData: null
    // through unchanged.
    let customerDataJson: string | null = null;
    if (activeCartLines.length === 1 && (activeCartLines[0]!.product.deliveryType === DeliveryType.MANUAL_WITH_INFO || activeCartLines[0]!.product.additionalFields)) {
      const line = activeCartLines[0]!;
      const fields = parseInputFields(line.product.additionalFields);
      customerDataJson = JSON.stringify(validateCustomerData(fields, customerData, line.quantity));
    }

    const created = await createOrderFromCart(tx, {
      channel: "web",
      user: {
        id: customer.userId,
        role: customer.user.role,
        walletBalance: customer.user.walletBalance,
      },
      voucherCode,
      customerData: customerDataJson,
    });
    if (!created) throw new ValidationError("error.generic");
    // A voucher or bulk rule can cover the whole cart, leaving nothing for the
    // rail the buyer picked to collect (M11). Settle it from the shop's own
    // books instead of opening a gateway payment for Rp0 — the buyer still
    // gets a paid, delivered order, which is what they are owed.
    if (orderHasNothingLeftToCollect(created)) {
      const settled = await settleFullyDiscountedOrder(tx, created.id);
      return { order: settled.order, settled: true, processing: settled.kind === "processing" };
    }
    return { order: await finalizeOrderPayment(tx, created.id, choice), settled: false, processing: false };
  });
  // The settlement has committed: start a Digiflazz-routed order's supplier
  // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
  if (order.processing) triggerDigiflazzDispatch(order.order!.id);
  return { orderCode: order.order!.orderCode, settledWithoutGateway: order.settled };
}

/**
 * "Pay entirely with wallet credit" — no gateway involved, settles
 * synchronously. Sibling of performCheckout (left untouched above) for the
 * all-or-nothing balance rail: only usable when the customer's IDR or USDT
 * credit balance fully covers the cart total (completeCartOrderWithWalletCredit
 * re-derives this from scratch and throws error.insufficient_wallet if not).
 */
export async function performWalletCheckout(
  customer: Customer,
  currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT,
  voucherCode: string | null,
  customerData?: unknown,
): Promise<{ orderCode: string }> {
  const rate = currency === OrderCurrency.USDT ? await getUsdIdrRate(prisma) : null;
  if (currency === OrderCurrency.USDT && !rate) throw new ValidationError("web.pay_method_unavailable");

  const result = await prisma.$transaction(async (tx) => {
    if ((await countUserPendingOrders(tx, customer.userId)) >= MAX_PENDING_ORDERS) {
      throw new ValidationError("error.too_many_pending");
    }
    return completeCartOrderWithWalletCredit(tx, {
      channel: "web",
      user: {
        id: customer.userId,
        role: customer.user.role,
        walletBalance: customer.user.walletBalance,
        walletBalanceUsdt: customer.user.walletBalanceUsdt,
      },
      voucherCode,
      currency,
      rate: rate ?? undefined,
      customerData,
    });
  });
  // The settlement has committed: start a Digiflazz-routed order's supplier
  // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
  if (result.kind === "processing") triggerDigiflazzDispatch(result.order.id);
  return { orderCode: result.order.orderCode };
}

/**
 * Server-side validation of a DIRECT purchase's manual_with_info answers,
 * stringified for `Order.customerData`.
 *
 * Exactly what performCheckout does for its cart's single non-auto line, just
 * keyed off the one denomination being bought instead of a cart read — the
 * client's own validation (InstantBuyPage.tsx) is a UX convenience only, never
 * trusted. auto/manual SKUs carry no field spec and store null.
 * `createOrderDirect` re-validates this again from scratch once inside the
 * transaction (it does that for every caller, including the bot's); running it
 * here too means a bad answer set is rejected before any row is written, and
 * re-validating already-valid data is a safe no-op.
 */
function directCustomerDataJson(
  denom: { deliveryType: string; additionalFields: string | null },
  quantity: number,
  customerData: unknown,
): string | null {
  if (denom.deliveryType !== DeliveryType.MANUAL_WITH_INFO && !denom.additionalFields) return null;
  const fields = parseInputFields(denom.additionalFields);
  return JSON.stringify(validateCustomerData(fields, customerData, quantity));
}

/**
 * Gateway sibling of performCheckout for a DIRECT (cart-free) purchase of one
 * denomination — the rail behind `POST /api/v1/topup/order` (routes/apiTopup.ts).
 *
 * Same method gate (resolveGatewayPaymentChoice), same per-buyer
 * MAX_PENDING_ORDERS cap, same finalizeOrderPayment hand-off; the only
 * difference is `createOrderDirect` instead of `createOrderFromCart`, which is
 * the single-denomination twin the Telegram bot has used in production since
 * before the storefront existed (apps/order-bot/src/handlers/checkout.ts). The
 * cart-only guards performCheckout carries are deliberately absent because
 * there is no cart to guard: no MAX_CART_ORDER_UNITS precheck (one line,
 * quantity validated by createOrderDirect's own assertValidQuantity) and no
 * mixed-delivery re-check (a single line cannot be mixed).
 *
 * `walletAmount` is deliberately not passed: a partial "wallet credit + pay the
 * rest by gateway" combination is a performCheckout feature that this pilot's
 * UI never offers — PaymentMethodSelector exposes wallet credit only as an
 * all-or-nothing method of its own, which lands on
 * performDirectWalletCheckout below. Half-supporting it here would spend the
 * buyer's balance on an order the page never told them would touch it.
 */
export async function performDirectCheckout(
  customer: Customer,
  line: AdHocLine,
  method: string,
  voucherCode: string | null,
  customerData?: unknown,
): Promise<{ orderCode: string; settledWithoutGateway: boolean }> {
  const choice = await resolveGatewayPaymentChoice(method);

  const order = await prisma.$transaction(async (tx) => {
    if ((await countUserPendingOrders(tx, customer.userId)) >= MAX_PENDING_ORDERS) {
      throw new ValidationError("error.too_many_pending");
    }
    // Re-read the denomination INSIDE the transaction rather than trusting the
    // route's own pre-check: it could have been deactivated in between, and
    // createOrderDirect itself does not check `isActive`.
    const denom = await getDenomination(tx, line.denominationId);
    if (!denom || !denom.isActive) throw new ValidationError("error.generic");

    const created = await createOrderDirect(tx, {
      channel: "web",
      user: { id: customer.userId, role: customer.user.role },
      productId: line.denominationId,
      quantity: line.quantity,
      voucherCode,
      customerData: directCustomerDataJson(denom, line.quantity, customerData),
    });
    if (!created) throw new ValidationError("error.generic");
    // Same zero-total routing as performCheckout above — see its comment,
    // including why the caller is told which branch ran.
    if (orderHasNothingLeftToCollect(created)) {
      const settled = await settleFullyDiscountedOrder(tx, created.id);
      return { order: settled.order, settled: true, processing: settled.kind === "processing" };
    }
    return { order: await finalizeOrderPayment(tx, created.id, choice), settled: false, processing: false };
  });
  // The settlement has committed: start a Digiflazz-routed order's supplier
  // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
  if (order.processing) triggerDigiflazzDispatch(order.order!.id);
  return { orderCode: order.order!.orderCode, settledWithoutGateway: order.settled };
}

/**
 * Wallet-credit sibling of performWalletCheckout for a DIRECT (cart-free)
 * purchase of one denomination — the `wallet_idr`/`wallet_usdt` branch of
 * `POST /api/v1/topup/order`. Settles synchronously, no gateway involved.
 *
 * `completeOrderWithWalletCredit` is the single-denomination twin of
 * `completeCartOrderWithWalletCredit` performWalletCheckout uses; like it, it
 * re-derives the price from scratch and throws `error.insufficient_wallet` if
 * the balance doesn't fully cover the order, so no sufficiency check is
 * duplicated here. Only a signed-in buyer can ever reach this — a guest has no
 * wallet, and both guest-minting helpers reject the wallet method tokens.
 */
export async function performDirectWalletCheckout(
  customer: Customer,
  line: AdHocLine,
  currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT,
  voucherCode: string | null,
  customerData?: unknown,
): Promise<{ orderCode: string }> {
  const rate = currency === OrderCurrency.USDT ? await getUsdIdrRate(prisma) : null;
  if (currency === OrderCurrency.USDT && !rate) throw new ValidationError("web.pay_method_unavailable");

  const result = await prisma.$transaction(async (tx) => {
    if ((await countUserPendingOrders(tx, customer.userId)) >= MAX_PENDING_ORDERS) {
      throw new ValidationError("error.too_many_pending");
    }
    const denom = await getDenomination(tx, line.denominationId);
    if (!denom || !denom.isActive) throw new ValidationError("error.generic");

    return completeOrderWithWalletCredit(tx, {
      channel: "web",
      user: {
        id: customer.userId,
        role: customer.user.role,
        walletBalance: customer.user.walletBalance,
        walletBalanceUsdt: customer.user.walletBalanceUsdt,
      },
      productId: line.denominationId,
      quantity: line.quantity,
      voucherCode,
      currency,
      rate: rate ?? undefined,
      // completeOrderWithWalletCredit takes this pre-stringified (unlike its
      // cart twin, which stringifies raw input itself), so validation happens
      // here — same call performDirectCheckout makes above.
      customerData: directCustomerDataJson(denom, line.quantity, customerData),
    });
  });
  // The settlement has committed: start a Digiflazz-routed order's supplier
  // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
  if (result.kind === "processing") triggerDigiflazzDispatch(result.order.id);
  return { orderCode: result.order.orderCode };
}

/**
 * Everything the React PayPage needs for one order, EXCLUDING the base shop
 * context — extracted verbatim from the former GET /checkout/:code/pay
 * handler so the JSON API (routes/apiCheckout.ts) has one implementation to
 * call, including the lazy gateway-transaction creation cached in
 * order.paymentRef. The caller has already verified ownership.
 */
export async function payView(order: OrderRow) {
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
  // QRIS admin fee — derived from immutable order fields, so it's always safe
  // to recompute (see @app/core/payments/tokopay computeQrisAdminFee doc).
  // Based on order.totalAmount (what's actually sent to the gateway as
  // `nominal`), NOT subtotalAmount — H-1 fix, backend audit 2026-07-31.
  const qrisAdminFee = isQris ? computeQrisAdminFee(order.totalAmount) : null;
  const qrisGrandTotal = isQris ? qrisChargeAmount(order.totalAmount) : null;

  let gateway: TokopayOrderInfo | null = null;
  let gatewayError = false;
  if (isQris && state === "waiting") {
    gateway = parseCachedGateway(order.paymentRef);
    const creds = await getTokopayCreds(prisma);
    minAmount = creds?.minAmount ?? null;
    if (!gateway) {
      if (creds) {
        // Atomic claim before the external call — two concurrent requests
        // for this order (e.g. a page double-load) must not both create a
        // TokoPay transaction (Data-2 fix, backend audit 2026-07-07). A lost
        // claim falls back to the same "contact us" UI as a gateway failure
        // below — that fallback already has a manual retry link, so no
        // polling loop is needed here.
        const claimSentinel = await claimGatewaySlot(prisma, order.id);
        if (claimSentinel) {
          try {
            gateway = await createTransaction(creds, {
              refId: order.orderCode,
              amountIdr: order.totalAmount,
            });
            const committed = await commitGatewayResult(prisma, order.id, claimSentinel, { gateway: "tokopay", ...gateway });
            if (!committed) {
              logger.warn(`Created a TokoPay transaction for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
            }
          } catch (err) {
            await releaseGatewaySlot(prisma, order.id, claimSentinel);
            logger.error({ err }, `Failed to create a TokoPay transaction for order ${order.orderCode} — showing the contact fallback instead of a QR code`);
            gatewayError = true;
          }
        } else {
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
        // Atomic claim before the external call — see the matching TokoPay
        // comment above (Data-2 fix, backend audit 2026-07-07).
        const claimSentinel = await claimGatewaySlot(prisma, order.id);
        if (claimSentinel) {
          try {
            paydisiniGateway = await createPaydisiniTransaction(creds, {
              refId: order.orderCode,
              amountIdr: order.totalAmount,
            });
            const committed = await commitGatewayResult(prisma, order.id, claimSentinel, { gateway: "paydisini", ...paydisiniGateway });
            if (!committed) {
              logger.warn(`Created a PayDisini transaction for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
            }
          } catch (err) {
            await releaseGatewaySlot(prisma, order.id, claimSentinel);
            logger.error({ err }, `Failed to create a PayDisini transaction for order ${order.orderCode} — showing the contact fallback instead of a QR code`);
            paydisiniGatewayError = true;
          }
        } else {
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
        // Atomic claim before the external call — see the matching TokoPay
        // comment above (Data-2 fix, backend audit 2026-07-07).
        const claimSentinel = await claimGatewaySlot(prisma, order.id);
        if (claimSentinel) {
          try {
            nowpaymentsGateway = await createNowpaymentsInvoice(creds, {
              orderId: order.orderCode,
              amountUsd: order.totalAmount,
              ipnCallbackUrl: `${publicUrl.replace(/\/+$/, "")}/pay/nowpayments/callback`,
            });
            const committed = await commitGatewayResult(prisma, order.id, claimSentinel, { gateway: "nowpayments", ...nowpaymentsGateway });
            if (!committed) {
              logger.warn(`Created a NOWPayments invoice for order ${order.orderCode} but couldn't cache it — the order's payment reference changed elsewhere during the external call.`);
            }
          } catch (err) {
            await releaseGatewaySlot(prisma, order.id, claimSentinel);
            logger.error({ err }, `Failed to create a NOWPayments invoice for order ${order.orderCode} — showing the contact fallback instead of a payment link`);
            nowpaymentsGatewayError = true;
          }
        } else {
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

  // Pre-formatted here (not on the client) since IDR vs USDT formatting
  // differs per method — null when unset, so the React PayPage just renders
  // the note iff this is non-empty.
  const minAmountDisplay = minAmount
    ? isQris || isPaydisini
      ? formatIdr(minAmount)
      : formatUsdt(minAmount)
    : null;

  return {
    order: {
      code: order.orderCode,
      status: order.status,
      currency: order.currency,
      total: order.totalAmount.toString(),
      qris_admin_fee: qrisAdminFee ? qrisAdminFee.toString() : null,
      qris_grand_total: qrisGrandTotal ? qrisGrandTotal.toString() : null,
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
  };
}

const checkoutRoutes: FastifyPluginAsync = async (app) => {
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
    if (!cb) {
      // Neither the signature nor the body is logged: the signature is the
      // credential this route authenticates on, and a rejected body is
      // attacker-controlled bytes (CLAUDE.md, "Never log secrets"). The fact of
      // the rejection is what an operator needs, and the rate limiter above
      // bounds how many of these one source can produce.
      logger.warn(
        `Rejected a TokoPay payment callback because its signature did not verify — no order was looked up and nothing was delivered. A few of these are ordinary internet noise hitting a public URL, but a steady stream against valid order codes is someone probing the callback, and a sudden start after a deploy usually means the merchant secret in Settings no longer matches TokoPay's.`,
      );
      return reply.code(403).send({ status: "bad signature" });
    }
    if (!cb.paid) return reply.send({ status: "ignored" }); // pending/failed callbacks

    const order = await getOrderByCode(prisma, cb.refId);
    // paymentMethod implies currency (finalizeOrderPayment always stamps them
    // together), but cross-check currency explicitly so a future bug that
    // decouples them can never let a TokoPay (IDR) callback amount be
    // compared against a USDT order's total (Payment-4 fix, security audit
    // 2026-06-23).
    if (!order || order.paymentMethod !== PaymentMethod.TOKOPAY || order.currency !== OrderCurrency.IDR) {
      await recordUnmatchedTokopayTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      logger.warn(
        `A signed TokoPay callback reported a payment of ${cb.amount.toString()} against reference "${cb.refId}", but no TokoPay rupiah order of that code exists — recorded as an unmatched transaction and left for manual review rather than delivered, because there is no order to deliver. Real money may have arrived with nobody credited for it, so somebody should find out whose payment this was.`,
      );
      return reply.send({ status: "unmatched" });
    }

    const expectedCharge = qrisChargeAmount(order.totalAmount);
    let live;
    try {
      live = await checkTransaction(creds, { refId: cb.refId, amountIdr: order.totalAmount });
    } catch (err) {
      logger.error({ err }, `Failed to check TokoPay's live transaction status for order ${order.orderCode} — the callback will be ignored until a retry confirms payment`);
      return reply.send({ status: "status check failed" });
    }
    if (live.unverified) {
      // TokoPay says PAID but gave no amount: never deliver on it, but money may
      // have arrived, so park it in the unmatched manual-review queue and alert
      // the admins once (the UNIQUE ledger key dedupes retries and the poller).
      // The row is reclaimable, so a later status that does carry the amount
      // still delivers normally.
      const unverifiedTrxId = gatewayLedgerTrxId(live.trxId, order.orderCode);
      await recordUnmatchedTokopayTx(prisma, { trxId: unverifiedTrxId, amount: 0 });
      // Deduped per (order, admin, reason) inside the helper, so every retry
      // and poller cycle can call it and each admin is told exactly once.
      await enqueueAdminUnconfirmablePayment(prisma, {
        orderId: order.id,
        orderCode: order.orderCode,
        gateway: "TokoPay",
        reason: "unverified_amount",
      });
      logger.warn(
        `TokoPay's live status reports order ${order.orderCode} as paid but carries no amount, so the payment could not be verified — nothing was delivered; it is parked in the unmatched queue and the admins were alerted to check it in the TokoPay dashboard`,
      );
      return reply.send({ status: "unverified" });
    }
    if (!live.paid) {
      logger.warn(
        `TokoPay callback claimed paid but live status check disagrees for ${order.orderCode} — trusting the live check over the callback body, so this delivery is skipped for now; the reconcile poller will retry and deliver once TokoPay's own status catches up`,
      );
      return reply.send({ status: "not confirmed live" });
    }
    // The idempotency-ledger key for this payment, derived by the one shared
    // rule the TokoPay reconcile poller also uses (`gatewayLedgerTrxId`,
    // @app/core/payments/ledgerKey) so the two paths always collide on the
    // same UNIQUE row when they see the same payment. Note this deliberately
    // ignores the body's own `trx_id`: the signature does not cover it, and
    // the live call is already this route's source of truth.
    const ledgerTrxId = gatewayLedgerTrxId(live.trxId, order.orderCode);
    // Amount sanity: never deliver on a short payment. Trust the LIVE amount
    // from checkTransaction, not the unsigned callback body field.
    if (live.amount.lessThan(expectedCharge)) {
      logger.warn(
        `TokoPay callback for order ${order.orderCode} is short-paid — got ${live.amount.toString()}, expected ${expectedCharge.toString()} — recording it as unmatched instead of delivering`,
      );
      await recordUnmatchedTokopayTx(prisma, { trxId: ledgerTrxId, amount: live.amount });
      return reply.send({ status: "amount mismatch" });
    }

    try {
      const r = await deliverPaidTokopayOrder(prisma, {
        orderId: order.id,
        trxId: ledgerTrxId,
        amount: live.amount,
        shopUrl: shopPublicUrl(),
      });
      // The settlement has committed: start a Digiflazz-routed order's supplier
      // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
      if (r.status === "processing") triggerDigiflazzDispatch(r.order.id);
      if (r.status === "delivered") nudgeOutboxDispatcher();
      if (r.status === "stale") {
        logger.warn(
          `TokoPay confirmed payment for order ${order.orderCode} (tx ${ledgerTrxId}) but it had already left PENDING_PAYMENT — likely auto-cancelled before this webhook arrived; admin alerted to verify and deliver manually`,
        );
        await enqueueAdminStalePayment(prisma, {
          orderId: order.id,
          orderCode: order.orderCode,
          gateway: "TokoPay",
          trxId: ledgerTrxId,
        });
      }
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
  //
  // M-9 fix (backend audit 2026-07-31): PayDisini's signature
  // (md5(apiKey:userKey:refId:amount)) does NOT cover `status` (see the ⚠
  // ASSUMPTION note in @app/core/payments/paydisini), so a body claiming any
  // `status` would otherwise pass as long as the signature for that
  // ref_id/amount is valid. Same design flaw TokoPay had — hardened the same
  // way: re-confirm the payment live against PayDisini's API
  // (`checkTransaction`) before trusting "paid" or using the amount for
  // delivery — a forged/replayed callback body can't fake that
  // server-to-server call.
  app.post("/pay/paydisini/callback", async (req, reply) => {
    // Payment-3 fix, security audit 2026-06-23 — see the TokoPay callback above.
    if (webhookRateLimited("paydisini", clientIp(req))) return reply.code(429).send({ status: "rate limited" });

    const creds = await getPaydisiniCreds(prisma);
    if (!creds) return reply.code(403).send({ status: "disabled" });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cb = verifyPaydisiniCallback(body, creds);
    if (!cb) {
      // Same reasoning as the TokoPay callback above — see the comment there
      // for why neither the signature nor the rejected body is logged.
      logger.warn(
        `Rejected a PayDisini payment callback because its signature did not verify — no order was looked up and nothing was delivered. A few of these are ordinary internet noise hitting a public URL, but a steady stream against valid order codes is someone probing the callback, and a sudden start after a deploy usually means the API key in Settings no longer matches PayDisini's.`,
      );
      return reply.code(403).send({ status: "bad signature" });
    }
    if (!cb.paid) return reply.send({ status: "ignored" }); // pending/failed callbacks

    const order = await getOrderByCode(prisma, cb.refId);
    // Payment-4 fix, security audit 2026-06-23 — see the TokoPay callback above.
    if (!order || order.paymentMethod !== PaymentMethod.PAYDISINI || order.currency !== OrderCurrency.IDR) {
      await recordUnmatchedPaydisiniTx(prisma, { trxId: cb.trxId, amount: cb.amount });
      logger.warn(
        `A signed PayDisini callback reported a payment of ${cb.amount.toString()} against reference "${cb.refId}", but no PayDisini rupiah order of that code exists — recorded as an unmatched transaction and left for manual review rather than delivered, because there is no order to deliver. Real money may have arrived with nobody credited for it, so somebody should find out whose payment this was.`,
      );
      return reply.send({ status: "unmatched" });
    }

    let live;
    try {
      live = await checkPaydisiniTransaction(creds, { refId: cb.refId, amountIdr: order.totalAmount });
    } catch (err) {
      logger.error({ err }, `Failed to check PayDisini's live transaction status for order ${order.orderCode} — the callback will be ignored until a retry confirms payment`);
      return reply.send({ status: "status check failed" });
    }
    if (live.unverified) {
      // Same as the TokoPay callback above: paid status, no amount — parked for
      // manual review with one admin alert, never delivered.
      const unverifiedTrxId = gatewayLedgerTrxId(live.trxId, order.orderCode);
      await recordUnmatchedPaydisiniTx(prisma, { trxId: unverifiedTrxId, amount: 0 });
      // Deduped per (order, admin, reason) inside the helper, so every retry
      // and poller cycle can call it and each admin is told exactly once.
      await enqueueAdminUnconfirmablePayment(prisma, {
        orderId: order.id,
        orderCode: order.orderCode,
        gateway: "PayDisini",
        reason: "unverified_amount",
      });
      logger.warn(
        `PayDisini's live status reports order ${order.orderCode} as paid but carries no amount, so the payment could not be verified — nothing was delivered; it is parked in the unmatched queue and the admins were alerted to check it in the PayDisini dashboard`,
      );
      return reply.send({ status: "unverified" });
    }
    if (!live.paid) {
      logger.warn(
        `PayDisini callback claimed paid but live status check disagrees for ${order.orderCode} — trusting the live check over the callback body, so this delivery is skipped for now; the reconcile poller will retry and deliver once PayDisini's own status catches up`,
      );
      return reply.send({ status: "not confirmed live" });
    }
    // Same shared ledger-key rule as the TokoPay callback above — see the
    // comment there and `gatewayLedgerTrxId`'s own doc comment
    // (@app/core/payments/ledgerKey) for why the body's `unique_code`/`trx_id`
    // is deliberately not part of the chain.
    const ledgerTrxId = gatewayLedgerTrxId(live.trxId, order.orderCode);
    // Amount sanity: never deliver on a short payment. Trust the LIVE amount
    // from checkTransaction, not the unsigned callback body field.
    if (live.amount.lessThan(order.totalAmount)) {
      logger.warn(
        `PayDisini callback for order ${order.orderCode} is short-paid — got ${live.amount.toString()}, expected ${order.totalAmount.toString()} — recording it as unmatched instead of delivering`,
      );
      await recordUnmatchedPaydisiniTx(prisma, { trxId: ledgerTrxId, amount: live.amount });
      return reply.send({ status: "amount mismatch" });
    }

    try {
      const r = await deliverPaidPaydisiniOrder(prisma, {
        orderId: order.id,
        trxId: ledgerTrxId,
        amount: live.amount,
        shopUrl: shopPublicUrl(),
      });
      // The settlement has committed: start a Digiflazz-routed order's supplier
      // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
      if (r.status === "processing") triggerDigiflazzDispatch(r.order.id);
      if (r.status === "delivered") nudgeOutboxDispatcher();
      if (r.status === "stale") {
        logger.warn(
          `PayDisini confirmed payment for order ${order.orderCode} (tx ${ledgerTrxId}) but it had already left PENDING_PAYMENT — likely auto-cancelled before this webhook arrived; admin alerted to verify and deliver manually`,
        );
        await enqueueAdminStalePayment(prisma, {
          orderId: order.id,
          orderCode: order.orderCode,
          gateway: "PayDisini",
          trxId: ledgerTrxId,
        });
      }
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
  // `x-nowpayments-sig`, not a body field, and is HMAC-SHA512 over the RAW
  // request body bytes (Task 2a fix — see nowpayments.ts's top doc comment
  // for why: re-serializing the parsed JSON with `JSON.stringify` risks a
  // byte-level mismatch, e.g. `1.50` vs `1.5`, that would silently break
  // every IPN's signature). `orderId` in the verified result is
  // `order.orderCode` (NOWPayments' `order_id`, set to orderCode when the
  // invoice was created above), so lookup is via getOrderByCode exactly like
  // the other two gateways. Same response contract: 403 disabled, 403 bad
  // signature, 200 for every other outcome (ignored/unmatched/amount
  // mismatch/delivered/delivery-failed) so NOWPayments stops retrying
  // regardless of outcome. ----
  //
  // Registered inside its own nested `app.register` so the raw-body-capturing
  // `addContentTypeParser` below is scoped ONLY to this one route (Fastify
  // encapsulates content-type parsers to the plugin context they're declared
  // in — see Fastify's ContentTypeParser reference) and never touches the
  // TokoPay/PayDisini webhooks that share this file's outer registration,
  // neither of which needs the raw body (their signature schemes hash
  // specific fields, not the whole body — see tokopay.ts/paydisini.ts). The
  // Digiflazz webhook below does hash the raw body and has its own scope.
  await app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "string" }, (req, rawBody: string, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
      if (rawBody === "") {
        // Mirrors Fastify's own default-parser rejection of an empty JSON body.
        const err = new Error("Body cannot be empty when content-type is set to 'application/json'") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        done(err, undefined);
        return;
      }
      try {
        done(null, JSON.parse(rawBody));
      } catch (err) {
        done(err as Error, undefined);
      }
    });

    scoped.post("/pay/nowpayments/callback", async (req, reply) => {
      // Payment-3 fix, security audit 2026-06-23 — see the TokoPay callback above.
      if (webhookRateLimited("nowpayments", clientIp(req))) return reply.code(429).send({ status: "rate limited" });

      const creds = await getNowpaymentsCreds(prisma);
      if (!creds) return reply.code(403).send({ status: "disabled" });

      const body = (req.body ?? {}) as Record<string, unknown>;
      const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? "";
      const sigHeader = req.headers["x-nowpayments-sig"];
      const cb = verifyIpn(rawBody, body, typeof sigHeader === "string" ? sigHeader : undefined, creds);
      if (!cb) {
        // Same reasoning as the TokoPay callback above — see the comment there
        // for why neither the signature nor the rejected body is logged. This
        // route has one extra way to land here that the other two do not: the
        // `x-nowpayments-sig` header can be missing entirely, which verifyIpn
        // rejects exactly like a wrong one.
        logger.warn(
          `Rejected a NOWPayments IPN callback because its signature header was missing or did not verify — no order was looked up and nothing was delivered. A few of these are ordinary internet noise hitting a public URL, but a steady stream against valid order codes is someone probing the callback, and a sudden start after a deploy usually means the IPN secret in Settings no longer matches NOWPayments'.`,
        );
        return reply.code(403).send({ status: "bad signature" });
      }
      // Only an EXACT "finished" status is a delivery — every other status
      // (waiting/confirming/confirmed/sending/partially_paid/failed/refunded/
      // expired) is "not ready yet" and ignored, never an error.
      if (!cb.paid) return reply.send({ status: "ignored" });

      const order = await getOrderByCode(prisma, cb.orderId);
      // Payment-4 fix, security audit 2026-06-23 — see the TokoPay callback above.
      if (!order || order.paymentMethod !== PaymentMethod.NOWPAYMENTS || order.currency !== OrderCurrency.USDT) {
        await recordUnmatchedNowpaymentsTx(prisma, { trxId: cb.trxId, amount: cb.amount });
        logger.warn(
          `A signed NOWPayments IPN reported a finished payment of ${cb.amount.toString()} against reference "${cb.orderId}", but no NOWPayments USDT order of that code exists — recorded as an unmatched transaction and left for manual review rather than delivered, because there is no order to deliver. Real money may have arrived with nobody credited for it, so somebody should find out whose payment this was.`,
        );
        return reply.send({ status: "unmatched" });
      }
      // Amount sanity: never deliver on a short/partial payment. Judged in the
      // invoice's price currency (usd), never by comparing the pay-currency
      // `actually_paid` to the USDT total — see checkNowpaymentsAmount (Task B3a).
      const valueCheck = checkNowpaymentsAmount(cb, order.totalAmount);
      if (!valueCheck.ok) {
        logger.warn(
          `NOWPayments reported a finished payment for order ${order.orderCode}, but it could not be confirmed as covering the order because ${valueCheck.reason} — recording it as unmatched for an admin to review instead of delivering`,
        );
        await recordUnmatchedNowpaymentsTx(prisma, { trxId: cb.trxId, amount: cb.amount });
        return reply.send({ status: "amount mismatch" });
      }

      try {
        const r = await deliverPaidNowpaymentsOrder(prisma, {
          orderId: order.id,
          trxId: cb.trxId,
          amount: valueCheck.amount,
          shopUrl: shopPublicUrl(),
        });
        // The settlement has committed: start a Digiflazz-routed order's supplier
        // request now (fire-and-forget, ignores non-Digiflazz orders, never throws).
        if (r.status === "processing") triggerDigiflazzDispatch(r.order.id);
        if (r.status === "delivered") nudgeOutboxDispatcher();
        if (r.status === "stale") {
          logger.warn(
            `NOWPayments confirmed payment for order ${order.orderCode} (tx ${cb.trxId}) but it had already left PENDING_PAYMENT — likely auto-cancelled before this webhook arrived; admin alerted to verify and deliver manually`,
          );
          await enqueueAdminStalePayment(prisma, {
            orderId: order.id,
            orderCode: order.orderCode,
            gateway: "NOWPayments",
            trxId: cb.trxId,
          });
        }
        return reply.send({ status: r.status });
      } catch (err) {
        logger.error({ err }, `Failed to deliver paid NOWPayments order ${order.orderCode} — flagging the ledger row delivery_failed for an admin to resolve from the orders panel`);
        // 200 so NOWPayments stops retrying — the ledger row is flagged delivery_failed
        // and an admin resolves it from the orders panel.
        return reply.send({ status: "delivery failed" });
      }
    });
  });

  // ---- Digiflazz webhook (public; signature is the auth) ----
  //
  // Signature: Digiflazz's documented scheme — `X-Hub-Signature: sha1=<hex>`,
  // HMAC-SHA1 of the RAW request body keyed by the webhook secret the shop
  // set in the Digiflazz dashboard (Settings key `digiflazz_webhook_secret`,
  // getDigiflazzWebhookSecret). See verifyWebhook in
  // @app/core/suppliers/digiflazz. It replaced an invented md5(ref_id:apiKey)
  // body field that Digiflazz never sends, which had made every real delivery
  // fail with 403 and left paid orders waiting on the poller. Like the
  // NOWPayments IPN above, the route lives in its own nested `app.register`
  // so its raw-body content-type parser is scoped to this one route.
  //
  // Task 12 fix (backend audit 2026-08-21, I-1/I-4): a signed delivery has no
  // timestamp or nonce, so a captured one (logging proxy, TLS-inspecting
  // appliance, leaked access log) can be replayed indefinitely. `cb` is used
  // ONLY to authenticate that a signed request named this refId and to
  // look up the order — never to decide what to actually do. What
  // actually happens is decided by a FRESH createTransaction(refId) call:
  // this client's own createTransaction is documented as idempotent by refId
  // (a repeat call with the same refId returns the existing transaction
  // rather than creating a new one — packages/core/src/suppliers/digiflazz.ts),
  // so calling it again here IS a live status re-check, built entirely from a
  // function this codebase already calls elsewhere (dispatchPendingDigiflazzOrders)
  // for exactly this SKU/order — no new supplier API surface.
  //
  // Idempotency against a duplicate/replayed live-Sukses report still comes
  // from fulfillDigiflazzOrder's own atomic PROCESSING -> DELIVERED claim
  // (packages/db/src/crud/digiflazz.ts): a replayed callback for an order the
  // dispatch poller (or an earlier callback) already delivered throws there,
  // caught below as an expected race rather than a real failure.
  await app.register(async (scoped) => {
    scoped.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, rawBody: Buffer, done) => {
      (req as FastifyRequest & { rawBody?: Buffer }).rawBody = rawBody;
      if (rawBody.length === 0) {
        // Mirrors Fastify's own default-parser rejection of an empty JSON body.
        const err = new Error("Body cannot be empty when content-type is set to 'application/json'") as Error & {
          statusCode?: number;
        };
        err.statusCode = 400;
        done(err, undefined);
        return;
      }
      try {
        done(null, JSON.parse(rawBody.toString("utf8")));
      } catch (err) {
        (err as Error & { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    });

    scoped.post("/pay/digiflazz/callback", async (req, reply) => {
      // Payment-3-style hardening — see the TokoPay callback above.
      if (webhookRateLimited("digiflazz", clientIp(req))) return reply.code(429).send({ status: "rate limited" });

      const creds = await getDigiflazzCreds(prisma);
      if (!creds) return reply.code(403).send({ status: "disabled" });
      const webhookSecret = await getDigiflazzWebhookSecret(prisma);
      if (!webhookSecret) {
        logger.warn(
          "Refused a Digiflazz webhook because no Digiflazz webhook secret is set in Settings, so its signature cannot be checked — paid top-ups will only be confirmed by the slower status poller until an admin sets the secret that is configured in the Digiflazz dashboard",
        );
        return reply.code(403).send({ status: "disabled" });
      }

      // Only the application/json parser above keeps the raw bytes. Any other
      // content type was parsed by Fastify's own parsers (or not at all), so
      // there is nothing the HMAC can be checked against — say exactly that
      // instead of reporting a signature mismatch that never happened.
      const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        logger.warn(
          "Refused a Digiflazz webhook because its body was not sent as JSON, so the raw bytes were not kept and its signature could not be checked — no order was looked up. Digiflazz itself always sends application/json; a steady stream of these is a misconfigured proxy or someone probing the callback.",
        );
        return reply.code(403).send({ status: "unsupported content type" });
      }
      const sigHeader = req.headers["x-hub-signature"];
      const inspection = inspectDigiflazzWebhook(webhookSecret, rawBody, typeof sigHeader === "string" ? sigHeader : undefined);
      if (!inspection.ok && inspection.reason === "no_reference") {
        // Signature verified, but there is no transaction in the body: a
        // Digiflazz test/ping delivery. Answer 200 so Digiflazz does not keep
        // retrying it; nothing is looked up or changed.
        logger.info(
          "Ignored a correctly signed Digiflazz webhook that carries no transaction reference (data.ref_id), which is what Digiflazz test and ping deliveries look like — no order was looked up.",
        );
        return reply.send({ status: "ignored" });
      }
      const cb = inspection.ok ? inspection.callback : null;
      if (!cb) {
        // Same reasoning as the TokoPay/PayDisini/NOWPayments callbacks above:
        // neither the signature nor the body is logged (CLAUDE.md, "Never log
        // secrets"), and the pre-existing `webhookRateLimited` check above already
        // bounds how many of these one source can produce.
        logger.warn(
          `Rejected a Digiflazz webhook because its X-Hub-Signature header was missing or did not match its body — no order was looked up and nothing was delivered. A steady stream against valid order codes is someone probing the callback; a sudden start usually means the webhook secret in Settings no longer matches the one set in the Digiflazz dashboard.`,
        );
        return reply.code(403).send({ status: "bad signature" });
      }

      const order = await getOrderByCode(prisma, cb.refId);
      if (!order) {
        logger.warn(`Digiflazz callback for unknown order ref ${cb.refId} — ignoring`);
        return reply.send({ status: "unmatched" });
      }
      // Timing event (docs/LOGGING.md, "Digiflazz timing events"): only ever
      // reached after the signature verified and the ref matched an order.
      // Carries the verified ref and the callback's status — never the body,
      // the signature or the secret.
      const msSinceDispatch = elapsedMs(order.digiflazzDispatchedAt, new Date());
      logDigiflazzTimingEvent(
        {
          event: DigiflazzTimingEvent.DIGIFLAZZ_WEBHOOK_RECEIVED,
          orderId: order.id,
          orderCode: order.orderCode,
          refId: cb.refId,
          callbackStatus: cb.status,
          msSinceDispatch,
        },
        `Received a verified Digiflazz webhook reporting ${cb.status} for order ${order.orderCode}${msSinceDispatch !== undefined ? ` ${msSinceDispatch} ms after it was dispatched` : ""}.`,
      );

      // Review fix (Important, post-Task-12): only an order still PROCESSING
      // can legitimately need a live re-check — a legitimate callback for an
      // in-flight order always finds it PROCESSING (fulfillDigiflazzOrder's own
      // atomic claim downstream requires exactly that). Refusing here for any
      // other status (DELIVERED, CANCELLED, REFUNDED, ...) is a pure narrowing
      // with no behavior change for the legitimate path, and closes off an
      // otherwise-valid replayed callback from turning into a real
      // POST /transaction to Digiflazz for an order that's already settled —
      // defense-in-depth on top of createTransaction's documented (but
      // unverified — see its ⚠ ASSUMPTION note, @app/core/suppliers/digiflazz)
      // refId-dedup behavior, not a replacement for it.
      if (order.status !== OrderStatus.PROCESSING) {
        logger.warn(
          `Digiflazz callback for order ${order.orderCode} but it is no longer PROCESSING (status: ${order.status}) — ignoring without a live re-check`,
        );
        return reply.send({ status: "unmatched" });
      }

      // I-4: confirm this order is actually a single-item Digiflazz-routed
      // order before doing anything else — a callback naming a manually-
      // fulfilled (or otherwise non-Digiflazz) order that happens to be
      // PROCESSING must never reach fulfillDigiflazzOrder. This branch means
      // the callback itself is suspect/mismatched, not that a legitimate
      // dispatch failed, so no alert is raised here.
      const resolution = resolveSingleDigiflazzItem(order);
      if (!resolution.ok) {
        logger.warn(
          `Digiflazz callback for order ${order.orderCode} but it isn't a single-item Digiflazz order (${resolution.reason}) — ignoring`,
        );
        return reply.send({ status: "unmatched" });
      }

      let customerNo: string;
      try { customerNo = buildDigiflazzCustomerNo(resolution.product, order.customerData, order.inputConfigSnapshot); }
      catch { return reply.send({ status: "unmatched" }); }

      // Task B3d (backend audit): a genuine callback can only exist after the
      // dispatch poller placed the purchase, and is only worth a re-check while
      // the order is still pending at Digiflazz. Anything else — never
      // dispatched, or already failed terminally — must not reach
      // createTransaction: from here that call could be a first or a second
      // purchase rather than a status check (its ref_id dedup is unverified).
      const dispatchedAt = order.digiflazzDispatchedAt;
      if (!dispatchedAt || order.digiflazzStatus !== "pending_at_supplier") {
        logger.warn(
          `Ignored a signed Digiflazz callback for order ${order.orderCode} without a live re-check, because the order is not waiting on Digiflazz (${dispatchedAt ? `its dispatch status is "${order.digiflazzStatus ?? "none"}"` : "it has not been dispatched yet"}) — re-posting the transaction from here could place a purchase instead of checking one`,
        );
        return reply.send({ status: "unmatched" });
      }
      // The recheck time the poller scheduled, read before the claim below
      // overwrites it with the in-flight lease. A Pending/transient result
      // from this webhook puts it back (recordDigiflazzOutcome, source
      // "webhook"): a replayable callback must never consume a backoff
      // attempt or move the schedule.
      const webhookOutcomeOptions = { source: "webhook" as const, scheduledRecheckAt: order.digiflazzNextRecheckAt };
      // At most one /transaction call per order at a time, across replays,
      // concurrent callbacks and the dispatch poller.
      if (!(await claimDigiflazzWebhookRecheck(prisma, order.id))) {
        logger.info(
          `Skipped the live re-check for a Digiflazz callback on order ${order.orderCode} because another check of that order is already in flight or due within minutes — that check records the outcome, so nothing is lost`,
        );
        return reply.send({ status: "ok" });
      }

      let result: DigiflazzTransactionResult;
      try {
        result = await createDigiflazzTransaction(creds, {
          refId: cb.refId,
          buyerSkuCode: resolution.supplierSku,
          customerNo,
        });
      } catch (err) {
        // The live re-check's HTTP call itself failed (network error, timeout,
        // malformed response — same failure modes dispatchPendingDigiflazzOrders's
        // own try/catch already handles). err's message is already
        // credential-free (fetchDigiflazzJson's own guarantee) — never log err
        // itself. Take no delivery action; leave the order PROCESSING for a
        // future callback or the next poller tick, matching this client's
        // "unrecognised status treated as Pending" philosophy elsewhere.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(`Digiflazz live re-check failed for order ${order.orderCode} (${message}) — leaving it PROCESSING`);
        try {
          await recordDigiflazzOutcome(prisma, order, { kind: "transient_error", message }, dispatchedAt, webhookOutcomeOptions);
        } catch (recordErr) {
          // Same guarantee as the Gagal/Pending branches below: a failure
          // writing this outcome (e.g. the DB update itself) must not surface
          // as an HTTP 500, or Digiflazz will retry-storm this endpoint.
          logger.warn({ err: recordErr }, `Digiflazz callback failed to record a transient re-check failure for order ${order.orderCode} — the live re-check's own failure was still logged above`);
        }
        return reply.send({ status: "ok" });
      }

      // Branch on the FRESH result.status from the live re-check — NOT
      // cb.status — this is the actual trust-model fix.
      if (result.status === "Sukses") {
        try {
          await fulfillDigiflazzOrder(prisma, order.id, { sn: result.sn ?? "" });
          nudgeOutboxDispatcher(); // same as the other gateways — buyer DM was just enqueued
        } catch (err) {
          // fulfillDigiflazzOrder throws if the order isn't PROCESSING anymore
          // (already delivered by the dispatch poller, or otherwise moved on)
          // — an expected race, not a real failure; log and 200 either way so
          // Digiflazz stops retrying.
          logger.warn({ err }, `Digiflazz callback fulfil race for order ${order.orderCode} — likely already delivered`);
        }
      } else if (result.status === "Gagal") {
        try {
          await recordDigiflazzOutcome(
            prisma,
            order,
            {
              kind: "terminal",
              reason: `Digiflazz live re-check reported Gagal${result.message ? ` (${result.message})` : ""}`,
              // Same rule as dispatchPendingDigiflazzOrders' own Gagal branch
              // (crud/digiflazz.ts) — only a bare "Gagal" with no message
              // triggers the reactive account/region diagnostic.
              supplierGaveReason: Boolean(result.message),
            },
            dispatchedAt,
          );
        } catch (err) {
          // Same guarantee as the Sukses branch above: a transient failure
          // here (e.g. the admin-alert/audit-log write inside
          // recordDigiflazzOutcome) must not surface as an HTTP 500, or
          // Digiflazz will retry-storm this endpoint.
          logger.warn({ err }, `Digiflazz callback failed to record Gagal for order ${order.orderCode} — Gagal status was still reported by the supplier`);
        }
      } else if (result.status === "Pending") {
        // Recorded through the same recordDigiflazzOutcome the poller uses (so
        // the realtime status feature sees it), but as a webhook outcome: the
        // attempt counter and the poller's scheduled recheck stay as they were.
        try {
          await recordDigiflazzOutcome(prisma, order, { kind: "pending" }, dispatchedAt, webhookOutcomeOptions);
        } catch (err) {
          logger.warn({ err }, `Digiflazz callback failed to record Pending for order ${order.orderCode} — supplier still reports Pending`);
        }
      }

      return reply.send({ status: "ok" });
    });
  });
};

export default checkoutRoutes;
