/**
 * An order's money rows in its OWN settlement currency, reconciled so they add
 * up: `itemsTotal - bulkDiscount - discount - walletCredit + uniqueCents ===
 * total`, exactly (B6, money audit; the L-1 class in
 * docs/archive/audit-backend-2026-07-31.md).
 *
 * Why derivation is needed. `subtotalAmount`/`bulkDiscountAmount`/
 * `discountAmount` are central IDR, while `totalAmount`/`walletUsed`/
 * `uniqueCents` are stamped in the settlement currency by
 * `finalizeOrderPayment`/`applyUsdtWalletToOrder`. Converting each IDR figure
 * on its own with `usdtFromIdr` (ceil to 0.01) does not reconcile:
 * `ceil(a) - ceil(b)` is not `ceil(a - b)`. At 16.000 IDR/USDT, 46.500 -> 2.91,
 * a 5.812,5 bulk discount -> 0.37, but the 40.687,5 net -> 2.55, and
 * 2.91 - 0.37 = 2.54.
 *
 * The rule. The net (`total + walletCredit - uniqueCents`) is exact by
 * construction — it IS the single conversion `finalizeOrderPayment` performed.
 * Each discount is converted once from its own IDR figure (`usdtFromIdr`, the
 * same rule as the charge). The ITEMS TOTAL absorbs the rounding remainder:
 * `itemsTotal = net + bulkDiscount + discount`. It is chosen because it is the
 * one row with no rule a reader can re-derive on its own (each discount is
 * "x% of" something; the wallet and marker are ledger/transfer figures the buyer
 * can check), and the remainder it absorbs is at most 0.01 per converted
 * discount. Same "convert one figure, derive the rest" technique as the guest
 * receipt (`enqueueBuyerOrderReadyEmailIfGuest`).
 *
 * IDR rows use whole-rupiah display rounding, including old fractional stored
 * adjustments. The displayed payable is the anchor; itemsTotal absorbs the
 * display residual. This is a pure presentation view, never a financial write.
 * An unconvertible USDT order without an fx snapshot retains its legacy values.
 */
import { Decimal } from "./money";
import { usdtFromIdr, wholeRupiah } from "./formatters";

export interface OrderMoneyRowsInput {
  currency: string;
  fxRate: Decimal.Value | null;
  subtotalAmount: Decimal.Value;
  bulkDiscountAmount: Decimal.Value;
  discountAmount: Decimal.Value;
  walletUsed: Decimal.Value;
  uniqueCents: Decimal.Value;
  totalAmount: Decimal.Value;
}

export interface OrderMoneyRows {
  itemsTotal: Decimal;
  bulkDiscount: Decimal;
  /** The voucher discount. */
  discount: Decimal;
  walletCredit: Decimal;
  uniqueCents: Decimal;
  total: Decimal;
}

export function reconciledOrderMoneyRows(order: OrderMoneyRowsInput): OrderMoneyRows {
  const total = new Decimal(order.totalAmount);
  const walletCredit = new Decimal(order.walletUsed);
  const uniqueCents = new Decimal(order.uniqueCents);
  if (order.currency === "IDR") {
    const displayedTotal = wholeRupiah(total);
    const displayedWallet = wholeRupiah(walletCredit);
    const displayedMarker = wholeRupiah(uniqueCents);
    const bulkDiscount = wholeRupiah(order.bulkDiscountAmount);
    const discount = wholeRupiah(order.discountAmount);
    return {
      itemsTotal: displayedTotal.plus(displayedWallet).minus(displayedMarker).plus(bulkDiscount).plus(discount),
      bulkDiscount,
      discount,
      walletCredit: displayedWallet,
      uniqueCents: displayedMarker,
      total: displayedTotal,
    };
  }
  if (order.fxRate == null) {
    return {
      itemsTotal: new Decimal(order.subtotalAmount),
      bulkDiscount: new Decimal(order.bulkDiscountAmount),
      discount: new Decimal(order.discountAmount),
      walletCredit,
      uniqueCents,
      total,
    };
  }
  const rate = order.fxRate;
  const bulkDiscount = usdtFromIdr(order.bulkDiscountAmount, rate);
  const discount = usdtFromIdr(order.discountAmount, rate);
  const net = total.plus(walletCredit).minus(uniqueCents);
  return {
    itemsTotal: net.plus(bulkDiscount).plus(discount),
    bulkDiscount,
    discount,
    walletCredit,
    uniqueCents,
    total,
  };
}
