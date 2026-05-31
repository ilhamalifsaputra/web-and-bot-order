/**
 * Referrals — port of the "_maybe_pay_referral_commission" helper.
 * Pays the referrer a % commission on the referee's FIRST delivered order.
 */
import { config } from "@app/core/config";
import { quantizeMoney } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { adjustWallet } from "./users";

export async function maybePayReferralCommission(
  db: Db,
  order: { id: number; userId: number; orderCode: string; totalAmount: Decimal.Value },
): Promise<void> {
  const user = await db.user.findUnique({ where: { id: order.userId } });
  if (!user || user.referredById === null) return;

  // Already paid for this referee?
  const existing = await db.referral.findUnique({
    where: { refereeId: user.id },
  });
  if (existing) return;

  const commission = quantizeMoney(
    new Decimal(order.totalAmount).times(config.REFERRAL_COMMISSION_PERCENT).div(100),
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
    `Paid referral commission ${commission} to user_id=${user.referredById} for order=${order.orderCode}`,
  );
}
