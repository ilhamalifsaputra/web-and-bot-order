/**
 * Order money-display shaping — split out of the old routes/orders.ts (a
 * legacy Nunjucks-era route file, since deleted) because routes/api/orders.ts
 * is its only remaining production caller.
 */
import { Decimal } from "@app/core/money";
import { reconciledOrderMoneyRows } from "@app/core/orderMoneyRows";

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
 * The rows come from `reconciledOrderMoneyRows` (@app/core/orderMoneyRows):
 * for a converted order the discounts are each converted once with the
 * charge's own rule, the already-settled total/wallet/marker are taken as
 * stored, and the items total absorbs the rounding remainder — so the rows
 * the admin reads always add up to the total (B6, money audit; converting
 * every IDR row independently with a ceiling did not: 2.91 - 0.37 beside a
 * 2.55 total).
 */
export function orderMoneyView(order: OrderMoneyInput): OrderMoneyView {
  const { currency, fxRate } = order;
  const rows = reconciledOrderMoneyRows(order);
  const totalToPay = rows.total;
  const equivalentIdr =
    currency !== "IDR" && fxRate ? totalToPay.times(fxRate) : null;

  return {
    currency,
    itemsTotal: rows.itemsTotal,
    bulkDiscount: hideIfZero(rows.bulkDiscount),
    discount: hideIfZero(rows.discount),
    walletCredit: hideIfZero(rows.walletCredit),
    amountMarker: hideIfZero(rows.uniqueCents),
    totalToPay,
    equivalentIdr,
  };
}
