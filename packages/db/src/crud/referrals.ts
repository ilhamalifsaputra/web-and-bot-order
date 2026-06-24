/**
 * Referrals — port of the "_maybe_pay_referral_commission" helper.
 * Pays the referrer a % commission on the referee's FIRST delivered order.
 *
 * The wallet stays USDT-denominated (plan.md §15.7 — wallet rules unchanged,
 * hidden on the web), so the commission base is the order's USDT value:
 * USDT orders already carry it; IDR (TokoPay) orders convert via the order's
 * fxRate snapshot or, failing that, the current usd_idr_rate. No rate at all
 * (misconfiguration) skips the commission with a loud log instead of
 * crediting a 16,000×-inflated Rupiah number into a USDT wallet.
 */
import { config } from "@app/core/config";
import { OrderCurrency } from "@app/core/enums";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { adjustWallet } from "./users";
import { getUsdIdrRate } from "./pricing";

export async function maybePayReferralCommission(
  db: Db,
  order: {
    id: number;
    userId: number;
    orderCode: string;
    totalAmount: Decimal.Value;
    currency?: string;
    fxRate?: Decimal.Value | null;
  },
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: order.userId } });
  if (!user || user.referredById === null) return;

  // Already paid for this referee?
  const existing = await db.referral.findUnique({
    where: { refereeId: user.id },
  });
  if (existing) return;

  // Commission base in USDT (the wallet currency).
  let baseUsdt = new Decimal(order.totalAmount);
  if ((order.currency ?? OrderCurrency.USDT) === OrderCurrency.IDR) {
    const rate =
      order.fxRate != null ? new Decimal(order.fxRate) : await getUsdIdrRate(db);
    if (!rate || rate.lessThanOrEqualTo(0)) {
      logger.warn(
        `Skipping referral commission for order ${order.orderCode} — it's an IDR order but no USD/IDR exchange rate is available to convert it to the USDT wallet`,
      );
      return;
    }
    baseUsdt = baseUsdt.div(rate);
  }

  const commission = quantizeMoney(
    baseUsdt.times(config.REFERRAL_COMMISSION_PERCENT).div(100),
    4,
  );
  if (commission.lessThanOrEqualTo(0)) return;

  await db.referral.create({
    data: {
      referrerId: user.referredById,
      refereeId: user.id,
      orderId: order.id,
      commission,
      paid: true,
    },
  });
  await adjustWallet(db, user.referredById, commission, { reason: "referral", orderId: order.id });
  logger.info(
    `Paid referral commission ${commission} to user ${user.referredById} for order ${order.orderCode}`,
  );
}
