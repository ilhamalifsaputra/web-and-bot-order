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
import { postReferralCommissionPosting } from "./ledgerPostings";
import { getUsdIdrRate } from "./pricing";

/** Referral earnings for one referrer — same aggregate the bot's
 * viewReferral handler (apps/order-bot/src/handlers/customer.ts) reads, so
 * the web and the bot can never disagree about a buyer's commission. `count`
 * is the number of distinct referred users who have generated a commission
 * (Referral.refereeId is unique per referee — see maybePayReferralCommission
 * above), not a count of orders. Zero referrals aggregates to a null sum;
 * that's normalized to Decimal(0) rather than surfacing null to callers. */
export interface ReferralSummary {
  referredCount: number;
  earnedUsdt: Decimal;
}

export async function getReferralSummary(db: Db, referrerId: number): Promise<ReferralSummary> {
  const agg = await db.referral.aggregate({
    where: { referrerId },
    _count: { id: true },
    _sum: { commission: true },
  });
  return {
    referredCount: agg._count.id,
    earnedUsdt: new Decimal(agg._sum.commission ?? 0),
  };
}

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
  /**
   * When the delivery that earned this commission happened (UTC), used as the
   * ledger posting's `occurredAt`. Defaults to now so the existing callers that
   * have no timestamp of their own (tests) keep working, but
   * `finalizeDeliverySideEffects` passes the same `now` it stamped the order
   * with — a commission is part of that one delivery event, not a separate
   * later one.
   */
  occurredAt: Date = new Date(),
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
    // `allowStale`: this is not a quote — the order is already settled and the
    // buyer has paid. All that is needed is a conversion factor to pay the
    // referrer's commission into the USDT wallet. Letting M13's staleness
    // kill-switch null this out would drop the commission on the floor
    // permanently (the branch below logs and returns; nothing retries it
    // later), turning an ops problem with the rate refresh into a silent money
    // loss for a customer who did nothing wrong. A slightly old rate on a
    // percentage-of-order commission is by far the smaller error.
    const rate =
      order.fxRate != null ? new Decimal(order.fxRate) : await getUsdIdrRate(db, { allowStale: true });
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

  // The check above is only a fast path: two deliveries for the same referee
  // at once both pass it. The unique refereeId decides the winner, and the
  // loser must be a quiet no-op — a plain create raised P2002, which aborted
  // the loser's whole delivery transaction (backend audit E2 item 5).
  // skipDuplicates makes the insert ON CONFLICT DO NOTHING; it waits for the
  // other insert to commit and then reports whether this one landed.
  const inserted = await db.referral.createMany({
    data: [
      {
        referrerId: user.referredById,
        refereeId: user.id,
        orderId: order.id,
        commission,
        paid: true,
      },
    ],
    skipDuplicates: true,
  });
  if (inserted.count === 0) return;
  const { transactionId } = await adjustWallet(db, user.referredById, commission, {
    reason: "referral",
    orderId: order.id,
    currency: "USDT",
  });
  // Record the commission as the cost it is: Dr referral_expense.usdt /
  // Cr wallet_liability.usdt. `occurredAt` is the caller's delivery timestamp
  // (`finalizeDeliverySideEffects` passes the same `now` it stamped the order
  // with), so the expense lands on the day the order that earned it was
  // delivered rather than on a clock read taken here.
  await postReferralCommissionPosting(db, {
    walletTransactionId: transactionId,
    orderId: order.id,
    orderCode: order.orderCode,
    occurredAt,
  });
  logger.info(
    `Paid referral commission ${commission} to user ${user.referredById} for order ${order.orderCode}`,
  );
}
