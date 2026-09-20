/**
 * "Pay entirely with wallet credit" checkout rail — for an order fully
 * covered by either the IDR or USDT credit balance, with no external
 * gateway involved. Composes the same primitives createInternalOrder uses
 * (createOrderDirect -> finalizeOrderPayment -> applyUsdtWalletToOrder for
 * the USDT track — packages/db/src/crud/binance_internal.ts), then claims +
 * settles the order via settlePaidOrder. For an AUTO SKU this returns the
 * delivered order + credentials, same as before; for a MANUAL /
 * MANUAL_WITH_INFO SKU it instead returns a "processing" result (no
 * credentials — settlePaidOrder already queued the order for hand-fulfilment
 * and enqueued the buyer's "being prepared" DM). Delivery of the account file
 * for a "delivered" result is the bot handler's job (completeOrderWithWallet
 * in apps/order-bot sends it directly, like the instant Binance Internal
 * rail), so this does NOT enqueue an outbox delivered-DM itself: there is
 * nothing to wait for, the credit already fully paid for the order.
 */
import { Decimal } from "@app/core/money";
import { OrderCurrency, OrderStatus, PaymentMethod } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { Db } from "./_types";
import {
  createOrderDirect,
  createOrderFromCart,
  getOrder,
  settlePaidOrder,
  applyUsdtWalletToOrder,
  type SettleResult,
} from "./orders";
import { finalizeOrderPayment } from "./pricing";
import { transitionOrderStatus } from "./orderStatus";
import { getCart, cartCompositionLineOfCartItem } from "./cart";
import { cartCompositionError } from "@app/core/cartComposition";

export type WalletCheckoutResult = SettleResult;

/**
 * Create + immediately deliver an order paid entirely by wallet credit.
 * Re-derives price/discount/stock from scratch via createOrderDirect — never
 * trusts a caller's "this is fully covered" claim. Throws
 * error.insufficient_wallet if, after applying the requested credit, the
 * order's total isn't exactly zero (balance changed since the caller last
 * checked, or the requested currency's credit didn't actually cover it).
 * Must run inside the caller's prisma.$transaction — a thrown error needs to
 * roll back the wallet deduction createOrderDirect already applied.
 */
export async function completeOrderWithWalletCredit(
  db: Db,
  args: {
    user: { id: number; role: string; walletBalance?: Decimal.Value; walletBalanceUsdt?: Decimal.Value };
    productId: number;
    quantity: number;
    voucherCode?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
    /** Rupiah per 1 USDT — required when currency is USDT. */
    rate?: Decimal.Value;
    /** Stringified JSON of the buyer's manual_with_info answers (validated by
     * the caller). Persisted verbatim onto Order.customerData; null otherwise. */
    customerData?: string | null;
    /** Client-minted checkout attempt id (A1) — forwarded verbatim to
     * createOrderDirect below; see {@link DuplicateCheckoutIntentError} in
     * orders.ts for the collision contract this enforces. It matters more here
     * than on any gateway rail: this function creates, settles AND delivers in
     * one transaction, so the resulting order is never left PENDING_PAYMENT and
     * the bot's best-effort `refuseDuplicateCheckout` pre-check (which filters
     * on that status) structurally cannot see a double-tap on this rail. The
     * unique index is the only guard. The throw happens on the createOrderDirect
     * INSERT below — before any wallet credit is spent or stock claimed — so the
     * loser's whole transaction rolls back with nothing debited or delivered. */
    checkoutIntentId?: string | null;
  },
): Promise<WalletCheckoutResult> {
  const created = await createOrderDirect(db, {
    user: { id: args.user.id, role: args.user.role, walletBalance: args.user.walletBalance },
    productId: args.productId,
    quantity: args.quantity,
    voucherCode: args.voucherCode,
    checkoutIntentId: args.checkoutIntentId,
    // Only the IDR track spends IDR credit during creation — the USDT track
    // leaves this order's walletAmount unset and applies USDT credit below,
    // exactly like createInternalOrder does for a partial USDT credit today.
    walletAmount: args.currency === OrderCurrency.IDR ? args.user.walletBalance : undefined,
    customerData: args.customerData,
  });
  if (!created) throw new ValidationError("error.order_not_found");

  if (args.currency === OrderCurrency.IDR) {
    await finalizeOrderPayment(db, created.id, { currency: OrderCurrency.IDR, method: PaymentMethod.WALLET });
  } else {
    if (!args.rate) throw new ValidationError("error.generic");
    await finalizeOrderPayment(db, created.id, {
      currency: OrderCurrency.USDT,
      rate: args.rate,
      method: PaymentMethod.WALLET,
    });
    await applyUsdtWalletToOrder(db, created.id, args.user.walletBalanceUsdt);
  }

  const finalized = await getOrder(db, created.id);
  if (!finalized) throw new ValidationError("error.order_not_found");
  if (new Decimal(finalized.totalAmount).greaterThan(0)) {
    // The requested credit didn't actually cover the order (stale preview,
    // or the balance moved between preview and this call) — refuse to
    // "complete" an order that still has money owing on it.
    throw new ValidationError("error.insufficient_wallet");
  }

  // No outbox delivered-DM here for the AUTO case — the caller
  // (completeOrderWithWallet) sends the account file directly, with an
  // outbox fallback only if that direct send fails, so wallet delivery
  // doesn't hinge on the outbox dispatcher running (same resilience as the
  // instant Binance Internal / Bybit rails). The MANUAL case's "being
  // prepared" DM is already enqueued by settlePaidOrder itself.
  return await markPaidAndSettle(db, finalized.id);
}

/**
 * Mark an order paid and run it through settlement — the shared tail of every
 * "nothing left to collect" rail in this file. Extracted so the three of them
 * cannot drift on the paid-at stamp, the status transition or its `meta` tag;
 * each caller keeps its own rule for WHY the order owes nothing.
 */
async function markPaidAndSettle(db: Db, orderId: number): Promise<WalletCheckoutResult> {
  await db.order.update({ where: { id: orderId }, data: { paidAt: new Date() } });
  await transitionOrderStatus(db, {
    orderId,
    from: OrderStatus.PENDING_PAYMENT,
    to: OrderStatus.PENDING_VERIFICATION,
    meta: "wallet_full_credit",
  });
  return await settlePaidOrder(db, orderId, { adminId: 0 });
}

/**
 * Is there anything left for a payment rail to collect on this freshly created
 * order? The one place that question is answered, so a checkout entry point
 * deciding to skip the gateway and {@link settleFullyDiscountedOrder} agreeing
 * to settle can never disagree.
 *
 * It subtracts the unique cents for the same reason `finalizeOrderPayment`
 * derives its `baseIdr` that way: the cents are matching noise the order
 * carries from creation (USE_UNIQUE_CENTS is on by default), not money anyone
 * owes. A voucher that covers an order's whole price therefore leaves a
 * `totalAmount` of a few hundredths of a Rupiah rather than a literal zero —
 * reading the column alone would silently miss every fully-discounted order on
 * a live deploy while passing in any test that turns unique cents off.
 */
export function orderHasNothingLeftToCollect(order: {
  totalAmount: Decimal.Value;
  uniqueCents: Decimal.Value;
}): boolean {
  return !new Decimal(order.totalAmount).minus(order.uniqueCents).greaterThan(0);
}

/**
 * Settle an order a discount alone already reduced to zero (M11 / audit P0-1).
 *
 * A voucher or bulk rule can cover an order's whole price before wallet credit
 * is even considered — `createOrderDirect`/`createOrderFromCart` stamp its
 * total as Rp0 and leave it PENDING_PAYMENT like any other. Until now the
 * checkout flow then handed that order to whichever gateway the buyer had
 * nominally picked, asking it to collect nothing; since M11's rail-minimum
 * guard that attempt is refused outright, which would leave a fully-discounted
 * order unbuyable by any route. So this is a ROUTING rule, not a rejection:
 * there is nothing to collect, so nothing is collected, and the buyer gets the
 * normal "paid, here's your delivery" outcome.
 *
 * Booked exactly like the wallet rails above — `paymentMethod: WALLET`,
 * currency IDR, no unique cents — because that is what actually happened: the
 * order was settled from the shop's own books with no external rail involved.
 * It moves no money, so it writes no WalletTransaction: `createOrderDirect`
 * only debits credit when `walletUsed` is above zero, and on a zero-total order
 * it never is. The buyer's chosen currency is deliberately not honoured; a zero
 * total converts to zero in either one, and booking a nonexistent charge in
 * USDT would attach an exchange rate to a payment that never happened.
 *
 * Must run inside the caller's `$transaction`, alongside the order creation it
 * follows, so a failure here rolls the whole checkout back.
 */
export async function settleFullyDiscountedOrder(db: Db, orderId: number): Promise<WalletCheckoutResult> {
  const order = await getOrder(db, orderId);
  if (!order) throw new ValidationError("error.order_not_found");
  if (!orderHasNothingLeftToCollect(order)) {
    // Caller misuse, not a buyer-facing state: this rail exists only for an
    // order that costs nothing, and settling one that still owes money would
    // deliver goods nobody paid for.
    throw new ValidationError("error.order_still_owing");
  }

  await finalizeOrderPayment(db, orderId, { currency: OrderCurrency.IDR, method: PaymentMethod.WALLET });
  return await markPaidAndSettle(db, orderId);
}

/**
 * Cart-based sibling of completeOrderWithWalletCredit, for the storefront
 * (whose cart supports multiple SKUs, unlike the bot's single-product
 * createOrderDirect rail). Same all-or-nothing contract: re-derives
 * price/discount/stock from scratch via createOrderFromCart, never trusts a
 * caller's "this is fully covered" claim, and throws error.insufficient_wallet
 * if the order's total isn't exactly zero afterward. Must run inside the
 * caller's prisma.$transaction for the same rollback reason as above.
 *
 * Replicates the cart-homogeneity guard performCheckout applies
 * (apps/storefront/src/routes/checkout.ts) before calling createOrderFromCart,
 * since createOrderFromCart itself does not enforce it. customerData
 * validation is NOT duplicated here — createOrderFromCart already
 * re-validates/normalizes a manual_with_info cart's answers from scratch
 * whenever its single active line requires them, so it's the caller's job
 * only to JSON-stringify the buyer's raw input, not to pre-validate it.
 */
export async function completeCartOrderWithWalletCredit(
  db: Db,
  args: {
    user: { id: number; role: string; walletBalance: Decimal.Value; walletBalanceUsdt?: Decimal.Value };
    voucherCode?: string | null;
    currency: typeof OrderCurrency.IDR | typeof OrderCurrency.USDT;
    /** Rupiah per 1 USDT — required when currency is USDT. */
    rate?: Decimal.Value;
    /** Buyer's raw manual_with_info answers, if any (not pre-stringified). */
    customerData?: unknown;
  },
): Promise<WalletCheckoutResult> {
  const cartLines = await getCart(db, args.user.id);
  const activeCartLines = cartLines.filter((ci) => ci.product.isActive);
  // The same shared `cart_kind` rule performCheckout applies — literally the
  // same function now, rather than a copy of its two-line check that had to be
  // kept in step by hand (Trustance Phase 1 Task 3). Rule and error keys
  // unchanged.
  const compositionError = cartCompositionError(activeCartLines.map(cartCompositionLineOfCartItem));
  if (compositionError) {
    throw new ValidationError(compositionError);
  }

  const created = await createOrderFromCart(db, {
    user: { id: args.user.id, role: args.user.role, walletBalance: args.user.walletBalance },
    voucherCode: args.voucherCode,
    // Only the IDR track spends IDR credit during creation — the USDT track
    // leaves this order's walletAmount unset and applies USDT credit below,
    // mirroring the single-SKU rail above.
    walletAmount: args.currency === OrderCurrency.IDR ? args.user.walletBalance : undefined,
    customerData: args.customerData != null ? JSON.stringify(args.customerData) : null,
  });
  if (!created) throw new ValidationError("error.generic");

  if (args.currency === OrderCurrency.IDR) {
    await finalizeOrderPayment(db, created.id, { currency: OrderCurrency.IDR, method: PaymentMethod.WALLET });
  } else {
    if (!args.rate) throw new ValidationError("error.generic");
    await finalizeOrderPayment(db, created.id, {
      currency: OrderCurrency.USDT,
      rate: args.rate,
      method: PaymentMethod.WALLET,
    });
    await applyUsdtWalletToOrder(db, created.id, args.user.walletBalanceUsdt);
  }

  const finalized = await getOrder(db, created.id);
  if (!finalized) throw new ValidationError("error.order_not_found");
  if (new Decimal(finalized.totalAmount).greaterThan(0)) {
    // The requested credit didn't actually cover the order (stale preview,
    // or the balance moved between preview and this call) — refuse to
    // "complete" an order that still has money owing on it.
    throw new ValidationError("error.insufficient_wallet");
  }

  // No outbox DM here either — the storefront's own OrderDetailPage reads
  // the order straight from the DB, there is no Telegram DM to send.
  return await markPaidAndSettle(db, finalized.id);
}
