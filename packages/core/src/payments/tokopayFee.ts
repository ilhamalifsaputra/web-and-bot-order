// packages/core/src/payments/tokopayFee.ts
/**
 * TokoPay's admin fee, per channel — for ESTIMATES only.
 *
 * The fee is TokoPay's own cut, paid by the buyer on top of the order total.
 * What a buyer is actually charged is whatever TokoPay returns as `total_bayar`
 * when the transaction is created; that figure is stored on the order
 * (`Order.gatewayChargeAmount`) and is what payments are matched against. This
 * table is used only where that figure does not exist yet (the storefront
 * checkout preview) or was never reported (`expectedTokopayCharge` fallback).
 *
 * Source: the shop owner's TokoPay dashboard tariff list and TokoPay's merchant
 * announcement, both dated 2026-11-11 (QRIS and QRIS_CUSTOM below Rp100.000 are
 * charged 0% + Rp25; QRISREALTIME is not). TokoPay has no API that lists
 * tariffs, so a tariff change needs an edit here; payments keep matching in
 * the meantime because they use the stored gateway figure.
 */
import { Decimal } from "../money";

export interface TokopayFeeTier {
  /** The tier applies when `amount < upTo`. Null on the last tier only. */
  upTo: string | null;
  /** Whole rupiah. */
  flat: string;
  /** Percent of the amount, e.g. "0.7" for 0.70%. */
  percent: string;
}

const flatFee = (rupiah: string): readonly TokopayFeeTier[] => [{ upTo: null, flat: rupiah, percent: "0" }];
const percentFee = (percent: string): readonly TokopayFeeTier[] => [{ upTo: null, flat: "0", percent }];

export const TOKOPAY_FEE_TABLE: Readonly<Record<string, readonly TokopayFeeTier[]>> = {
  // QRIS
  QRIS: [
    { upTo: "100000", flat: "25", percent: "0" },
    { upTo: null, flat: "100", percent: "0.7" },
  ],
  QRIS_CUSTOM: [
    { upTo: "100000", flat: "25", percent: "0" },
    { upTo: null, flat: "250", percent: "0.7" },
  ],
  QRISREALTIME: percentFee("1.7"),
  QRIS_WK: percentFee("1.2"),
  // Virtual account
  BRIVA: flatFee("3000"),
  BCAVA: flatFee("4200"),
  BNIVA: flatFee("3500"),
  MANDIRIVA: flatFee("3500"),
  PERMATAVA: flatFee("2000"),
  CIMBVA: flatFee("2500"),
  DANAMONVA: flatFee("2500"),
  BSIVA: flatFee("3500"),
  BNCVA: flatFee("3000"),
  PERMATAVAA: flatFee("3000"),
  // E-money
  SHOPEEPAY: percentFee("2.5"),
  GOPAY: percentFee("3"),
  DANA: percentFee("2.5"),
  LINKAJA: percentFee("3"),
  VIRGO: percentFee("2"),
  ASTRAPAY: percentFee("2.5"),
  OVOPUSH: percentFee("2.5"),
  DANA_REALTIME: percentFee("3.2"),
  SHOPEEPAY_REALTIME: percentFee("3"),
  GOPAY_REALTIME: percentFee("3.5"),
  OVOPUSH_REALTIME: percentFee("2.7"),
  // E-money custom name
  DANA_CUSTOM: percentFee("2.5"),
  SHOPEE_CUSTOM: percentFee("2.5"),
  OVO_CUSTOM: percentFee("2.5"),
  LINKAJA_CUSTOM: percentFee("2.5"),
  // Retail
  ALFAMART: flatFee("3000"),
  INDOMARET: flatFee("3000"),
  // Pulsa
  TELKOMSEL: percentFee("32"),
  AXIS: percentFee("25"),
  XL: percentFee("25"),
  TRI: percentFee("25"),
  SMARTFREN: percentFee("25"),
};

function tiersFor(channel: string): readonly TokopayFeeTier[] | undefined {
  return TOKOPAY_FEE_TABLE[channel.trim().toUpperCase()];
}

/** The estimated admin fee for `amount` on `channel`, in whole rupiah (half-up);
 *  null when the channel code is not in the table. */
export function estimateTokopayFee(channel: string, amount: Decimal.Value): Decimal | null {
  const tiers = tiersFor(channel);
  if (!tiers) return null;
  const value = new Decimal(amount);
  const tier = tiers.find((candidate) => candidate.upTo === null || value.lessThan(candidate.upTo));
  if (!tier) return null;
  return new Decimal(tier.flat)
    .plus(value.times(tier.percent).dividedBy(100))
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/** `totalAmount` plus the estimated fee; an unknown channel adds nothing. */
export function estimatedTokopayCharge(channel: string, totalAmount: Decimal.Value): Decimal {
  return new Decimal(totalAmount).plus(estimateTokopayFee(channel, totalAmount) ?? 0);
}

/** Plausibility cap on the fee implied by TokoPay's `total_bayar`:
 *  max(10%, twice the channel's highest table percent) of the total, plus Rp10.000. */
export const TOKOPAY_MAX_FEE_PERCENT = new Decimal(10);
export const TOKOPAY_MAX_FEE_FLAT = new Decimal(10000);

export type TokopayChargeReading =
  | { kind: "ok"; charge: Decimal }
  | { kind: "missing" }
  | { kind: "implausible" };

/**
 * Read TokoPay's `total_bayar` for an order. "ok" is a whole-rupiah figure at or
 * above the nominal sent to TokoPay whose implied fee is within the cap;
 * "missing" is a null or blank value; anything else is "implausible" and must
 * not be shown to a buyer or stored.
 */
export function readTokopayCharge(
  channel: string,
  totalAmount: Decimal.Value,
  totalBayar: string | null | undefined,
): TokopayChargeReading {
  if (totalBayar == null || totalBayar.trim() === "") return { kind: "missing" };
  let charge: Decimal;
  try {
    charge = new Decimal(totalBayar.trim());
  } catch {
    return { kind: "implausible" };
  }
  if (!charge.isFinite() || !charge.isInteger()) return { kind: "implausible" };
  // createTransaction sends `nominal` as `toFixed(0)` of the order total.
  const nominal = new Decimal(new Decimal(totalAmount).toFixed(0));
  if (charge.lessThan(nominal)) return { kind: "implausible" };
  const tiers = tiersFor(channel);
  const highestPercent = tiers ? Decimal.max(...tiers.map((tier) => new Decimal(tier.percent))) : new Decimal(0);
  const capPercent = Decimal.max(TOKOPAY_MAX_FEE_PERCENT, highestPercent.times(2));
  const cap = nominal.times(capPercent).dividedBy(100).plus(TOKOPAY_MAX_FEE_FLAT);
  if (charge.minus(nominal).greaterThan(cap)) return { kind: "implausible" };
  return { kind: "ok", charge };
}

/**
 * What the buyer must pay on a TokoPay order: the figure TokoPay reported when
 * the transaction was created, or — only when none was stored — the table
 * estimate. The ONE place this is decided; every paid-amount check, overpayment
 * check and fee figure derives from it (fee = charge - totalAmount).
 */
export function expectedTokopayCharge(
  order: { totalAmount: Decimal.Value; gatewayChargeAmount?: Decimal.Value | null },
  channel: string,
): Decimal {
  if (order.gatewayChargeAmount != null) return new Decimal(order.gatewayChargeAmount);
  return estimatedTokopayCharge(channel, order.totalAmount);
}
