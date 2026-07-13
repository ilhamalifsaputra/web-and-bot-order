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
import { createOrderDirect, getOrder, settlePaidOrder, applyUsdtWalletToOrder, type SettleResult } from "./orders";
import { finalizeOrderPayment } from "./pricing";
import { transitionOrderStatus } from "./orderStatus";

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
  },
): Promise<WalletCheckoutResult> {
  const created = await createOrderDirect(db, {
    user: { id: args.user.id, role: args.user.role, walletBalance: args.user.walletBalance },
    productId: args.productId,
    quantity: args.quantity,
    voucherCode: args.voucherCode,
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

  await db.order.update({ where: { id: finalized.id }, data: { paidAt: new Date() } });
  await transitionOrderStatus(db, {
    orderId: finalized.id,
    from: OrderStatus.PENDING_PAYMENT,
    to: OrderStatus.PENDING_VERIFICATION,
    meta: "wallet_full_credit",
  });
  // No outbox delivered-DM here for the AUTO case — the caller
  // (completeOrderWithWallet) sends the account file directly, with an
  // outbox fallback only if that direct send fails, so wallet delivery
  // doesn't hinge on the outbox dispatcher running (same resilience as the
  // instant Binance Internal / Bybit rails). The MANUAL case's "being
  // prepared" DM is already enqueued by settlePaidOrder itself.
  return await settlePaidOrder(db, finalized.id, { adminId: 0 });
}
