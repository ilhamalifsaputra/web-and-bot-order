/**
 * The money rows of the QRIS payment screen (`checkout.qris_instructions`),
 * shared by the order checkout (`buyNowTokopay`) and the IDR wallet top-up.
 *
 * The rows are stacked, so they must add up (B7, money audit):
 *
 *     Subtotal            Rp100.000
 *     Voucher             −Rp20.000
 *     QRIS admin fee         +Rp660
 *     Total to pay         Rp80.660
 *
 * The screen used to print the GROSS subtotal, then the fee, then the net
 * total plus fee — so any discount was invisible and the arithmetic did not
 * close. Now every reduction between the gross subtotal and the amount sent to
 * the gateway gets its own row: the quantity (bulk) discount and the wallet
 * credit verbatim, and the voucher row DERIVED as whatever remains
 * (`subtotal - bulk - wallet - total`, never below zero) — the same "derive the
 * adjustment" rule the buyer's order page and guest receipt use, so a legacy
 * order whose stored discount carried sub-rupiah residue still prints rows that
 * add up. IDR only: both callers are IDR rails. Formatting goes through the
 * language-aware `formatIdrFor`.
 */
import { Decimal } from "@app/core/money";
import { formatIdrFor } from "@app/core/moneyFormat";
import { computeQrisAdminFee } from "@app/core/payments/tokopay";
import { coreT } from "./i18n";

export interface QrisCaptionOrder {
  subtotalAmount: Decimal.Value;
  bulkDiscountAmount: Decimal.Value;
  discountAmount: Decimal.Value;
  walletUsed: Decimal.Value;
  totalAmount: Decimal.Value;
}

export interface QrisCaptionAmounts {
  subtotal: string;
  /** Zero or more "−Rp…" rows, each ending in a newline. */
  discount_lines: string;
  fee: string;
  amount: string;
  /** The fee and the payable, for callers that also need the numbers. */
  adminFee: Decimal;
  chargeAmount: Decimal;
}

const ZERO = new Decimal(0);

export function qrisCaptionAmounts(order: QrisCaptionOrder, lang: string | null | undefined): QrisCaptionAmounts {
  const subtotal = new Decimal(order.subtotalAmount);
  const total = new Decimal(order.totalAmount);
  const bulk = Decimal.max(ZERO, new Decimal(order.bulkDiscountAmount));
  const wallet = Decimal.max(ZERO, new Decimal(order.walletUsed));
  const voucher = Decimal.max(ZERO, subtotal.minus(bulk).minus(wallet).minus(total));
  const adminFee = computeQrisAdminFee(total);
  const chargeAmount = total.plus(adminFee);
  const l = lang ?? "en";
  const row = (key: string, amount: Decimal) =>
    amount.greaterThan(0) ? coreT(key, l, { amount: formatIdrFor(amount, l) }) : "";
  return {
    subtotal: formatIdrFor(subtotal, l),
    discount_lines:
      row("checkout.qris_bulk_line", bulk) +
      row("checkout.qris_voucher_line", voucher) +
      row("checkout.qris_wallet_line", wallet),
    fee: formatIdrFor(adminFee, l),
    amount: formatIdrFor(chargeAmount, l),
    adminFee,
    chargeAmount,
  };
}
