/**
 * What a buyer must pay on a TokoPay order.
 *
 * TokoPay's admin fee is its own cut, paid by the buyer on top of the order
 * total, and TokoPay changes it without notice (it has no API that lists
 * tariffs). So this codebase holds NO fee formula: the figure TokoPay returns
 * as `total_bayar` when a transaction is created is stored on the order
 * (`Order.gatewayChargeAmount`) and every paid-amount check, overpayment check
 * and fee figure derives from that stored figure.
 */
import { Decimal } from "../money";

/** Guard against a broken gateway response, not a tariff: the fee implied by
 *  `total_bayar` may be at most 50% of the order total plus Rp10.000. */
export const TOKOPAY_MAX_FEE_PERCENT = new Decimal(50);
export const TOKOPAY_MAX_FEE_FLAT = new Decimal(10000);

export type TokopayChargeReading =
  | { kind: "ok"; charge: Decimal }
  | { kind: "missing" }
  | { kind: "implausible" };

/**
 * Read TokoPay's `total_bayar` for an order. "ok" is plain digits (whole
 * rupiah), at or above the nominal sent to TokoPay, with an implied fee within
 * the cap. "missing" is null or blank. Anything else is "implausible". Only an
 * "ok" figure may be shown to a buyer or stored.
 */
export function readTokopayCharge(
  totalAmount: Decimal.Value,
  totalBayar: string | null | undefined,
): TokopayChargeReading {
  if (totalBayar == null || totalBayar.trim() === "") return { kind: "missing" };
  const text = totalBayar.trim();
  if (!/^\d+$/.test(text)) return { kind: "implausible" };
  const charge = new Decimal(text);
  // createTransaction sends `nominal` as `toFixed(0)` of the order total.
  const nominal = new Decimal(new Decimal(totalAmount).toFixed(0));
  if (charge.lessThan(nominal)) return { kind: "implausible" };
  const cap = nominal.times(TOKOPAY_MAX_FEE_PERCENT).dividedBy(100).plus(TOKOPAY_MAX_FEE_FLAT);
  if (charge.minus(nominal).greaterThan(cap)) return { kind: "implausible" };
  return { kind: "ok", charge };
}

/**
 * The amount the buyer was asked to pay on a TokoPay order: the figure TokoPay
 * reported when the transaction was created. The ONE place this is decided;
 * the buyer-side fee is always `expectedTokopayCharge(order) - order.totalAmount`.
 *
 * An order with no stored figure never had its TokoPay transaction recorded;
 * the bare order total is then the least a payment must cover, so a real
 * payment still settles and its fee portion surfaces as an overpayment for an
 * admin to look at instead of the order getting stuck.
 */
export function expectedTokopayCharge(order: {
  totalAmount: Decimal.Value;
  gatewayChargeAmount?: Decimal.Value | null;
}): Decimal {
  return new Decimal(order.gatewayChargeAmount ?? order.totalAmount);
}
