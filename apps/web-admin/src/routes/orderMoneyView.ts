/**
 * Order money-display shaping — split out of the old routes/orders.ts (a
 * legacy Nunjucks-era route file, since deleted) because routes/api/orders.ts
 * is its only remaining production caller.
 */
import { Decimal } from "@app/core/money";
import { usdtFromIdr } from "@app/core/formatters";

/** The Order fields `orderMoneyView` needs — a narrow shape so it stays a
 * plain unit-testable function rather than depending on the full Prisma
 * include shape `getOrder` returns. */
export interface OrderMoneyInput {
  currency: string;
  fxRate: Decimal.Value | null;
  subtotalAmount: Decimal.Value;
  bulkDiscountAmount: Decimal.Value;
  discountAmount: Decimal.Value;
  walletUsed: Decimal.Value;
  uniqueCents: Decimal.Value;
  totalAmount: Decimal.Value;
}

export interface OrderMoneyView {
  currency: string;
  itemsTotal: Decimal;
  /** null = hide the row (the underlying amount is zero). */
  bulkDiscount: Decimal | null;
  discount: Decimal | null;
  walletCredit: Decimal | null;
  amountMarker: Decimal | null;
  totalToPay: Decimal;
  /** IDR equivalent of `totalToPay` for a non-IDR order, via the order's
   * locked fx snapshot — null when the order is IDR or has no snapshot. */
  equivalentIdr: Decimal | null;
}

function hideIfZero(value: Decimal): Decimal | null {
  return value.isZero() ? null : value;
}

/**
 * Shape an order's money fields for display, each expressed in the order's
 * OWN settlement currency (`order.currency`) instead of assuming IDR.
 *
 * `subtotalAmount`/`bulkDiscountAmount`/`discountAmount` are always computed
 * at checkout time from the central-IDR catalog (see `createOrderFromCart` /
 * `createOrderDirect` in packages/db/src/crud/orders.ts) and need converting
 * via the order's locked `fxRate` snapshot when the order settled in a
 * different currency. `walletUsed`/`uniqueCents`/`totalAmount` are already
 * stamped in the order's settlement currency by `finalizeOrderPayment` /
 * `applyUsdtWalletToOrder` — converting them again would double-convert.
 */
export function orderMoneyView(order: OrderMoneyInput): OrderMoneyView {
  const { currency, fxRate } = order;
  const toOrderCurrency = (value: Decimal.Value): Decimal => {
    const v = new Decimal(value);
    return currency === "IDR" || !fxRate ? v : usdtFromIdr(v, fxRate);
  };

  const totalToPay = new Decimal(order.totalAmount);
  const equivalentIdr =
    currency !== "IDR" && fxRate ? totalToPay.times(fxRate) : null;

  return {
    currency,
    itemsTotal: toOrderCurrency(order.subtotalAmount),
    bulkDiscount: hideIfZero(toOrderCurrency(order.bulkDiscountAmount)),
    discount: hideIfZero(toOrderCurrency(order.discountAmount)),
    walletCredit: hideIfZero(new Decimal(order.walletUsed)),
    amountMarker: hideIfZero(new Decimal(order.uniqueCents)),
    totalToPay,
    equivalentIdr,
  };
}
