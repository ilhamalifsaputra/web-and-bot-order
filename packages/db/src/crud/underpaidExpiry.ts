/**
 * Aged UNDERPAID and FAILED orders (backend audit A4).
 *
 * The expiry sweep (`listExpiredPendingOrders` + `cancelOrder`) only ever
 * looked at PENDING_PAYMENT, so an order that moved on to UNDERPAID or FAILED
 * kept everything checkout gave it — reserved stock rows, the buyer's spent
 * wallet credit (`walletUsed`), its voucher use — until an admin happened to
 * act on it, which could be never.
 *
 * UNDERPAID (part of the money arrived, never settled):
 *   Once the owner sets a limit (`underpaid_auto_resolve_hours`, OFF by
 *   default — "0" or blank; 72 h is the suggested value), a PRODUCT order
 *   older than it is resolved through the existing admin
 *   resolution `refundUnderpaidOrderTx`: the amount a rail recorded as
 *   received goes to the buyer's balance in the order's own currency, every
 *   hold is released, a Refund record is written and the order becomes
 *   REFUNDED. No new money path: the same function the Payments page's
 *   "Refund to wallet" button runs, so both credit under the same
 *   `underpaid_refund` reason and the `wallet_transactions` UNIQUE(orderId,
 *   reason) index backs up the status check against a double credit.
 *   The sweep leaves an order for a human (one deduped admin alert) when it
 *   cannot prove the safe outcome: a wallet top-up (whether a TokoPay fee was
 *   covered is an admin decision — `creditUnderpaidTopupAnyway`), no recorded
 *   received amount (crediting 0 could strand real money), an order the
 *   supplier may still complete (Digiflazz), or one that looks paid.
 *
 * FAILED (usually fully paid, fulfilment failed):
 *   Never changed automatically. Nothing on the order proves no money arrived
 *   (the Bybit BSC writer moves an order to FAILED precisely AFTER Bybit
 *   reported the deposit successful), so cancelling would strand the payment
 *   and crediting could pay out money that never came. After
 *   `failed_order_alert_hours` (default 24 h, "0" turns it off) the admins get
 *   one deduped alert so the order cannot sit unnoticed.
 *
 * "Entered the status at" is the latest OrderStatusHistory row for that status
 * (every `transitionOrderStatus` writes one); an order without one — moved by
 * hand in the database — falls back to its creation time.
 */
import type { Prisma } from "@prisma/client";
import { NotificationEvent, OrderKind, OrderStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import type { Decimal } from "@app/core/money";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { getSetting } from "./settings";
import { getOrderRaw, isDigiflazzCreditLocked } from "./orders";
import { findUnderpaidReceived } from "./_underpaid";
import { refundUnderpaidOrderTx } from "./binance_internal";
import { logAdminAction } from "./audit";
import { resolveAdminIds } from "./admins";
import { enqueueTransactionReviewAlert } from "./notifications";

/** Settings key: hours an UNDERPAID product order may wait before the sweep
 * refunds what arrived to the buyer's wallet. Blank or "0" = never.
 *
 * OFF by default: switching it on for the first time refunds the whole
 * existing UNDERPAID backlog older than the limit, which is the owner's call
 * to make (72 is a sensible value once they do), never a deploy side effect. */
export const UNDERPAID_AUTO_RESOLVE_HOURS_KEY = "underpaid_auto_resolve_hours";
export const DEFAULT_UNDERPAID_AUTO_RESOLVE_HOURS = "0";

/** Settings key: hours a FAILED order may sit before the admins are alerted
 * (once). Blank or "0" = no alert. */
export const FAILED_ORDER_ALERT_HOURS_KEY = "failed_order_alert_hours";
export const DEFAULT_FAILED_ORDER_ALERT_HOURS = "24";

/** Orders handled per status per sweep run; the rest wait for the next run. */
const SWEEP_BATCH = 50;

const HOUR_MS = 3_600_000;
const UNDERPAID_INCIDENT = "underpaid_unresolved";
const FAILED_INCIDENT = "failed_aging";

/**
 * A whole number of hours, or null for "off". A missing row uses the default;
 * blank, "0" and anything that is not a plain positive whole number mean off —
 * a typo must never make the sweep act sooner than the owner intended.
 */
async function readHoursSetting(db: Db, key: string, fallback: string): Promise<number | null> {
  const raw = (await getSetting(db, key)) ?? fallback;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) {
    // Once per process and value: the sweep runs every ten minutes, and the
    // same unchanged typo is not news the second time.
    const warnKey = `${key}=${trimmed.slice(0, 20)}`;
    if (!warnedInvalidSettings.has(warnKey)) {
      warnedInvalidSettings.add(warnKey);
      logger.warn(
        `The setting ${key} holds "${trimmed.slice(0, 20)}", which is not a whole number of hours, so the aged-order sweep treats it as switched off until an admin fixes it.`,
      );
    }
    return null;
  }
  // "0", "00", … all mean off — never "act immediately".
  const hours = Number(trimmed);
  return hours > 0 ? hours : null;
}

/** Invalid setting values already warned about by this process. */
const warnedInvalidSettings = new Set<string>();

export function getUnderpaidAutoResolveHours(db: Db): Promise<number | null> {
  return readHoursSetting(db, UNDERPAID_AUTO_RESOLVE_HOURS_KEY, DEFAULT_UNDERPAID_AUTO_RESOLVE_HOURS);
}

export function getFailedOrderAlertHours(db: Db): Promise<number | null> {
  return readHoursSetting(db, FAILED_ORDER_ALERT_HOURS_KEY, DEFAULT_FAILED_ORDER_ALERT_HOURS);
}

/**
 * Orders in `status` that entered it before `cutoff` (see the module note) and
 * have not already been raised to the admins for `incident` — an order left
 * for a human stays out of later batches, so it cannot crowd out new ones.
 */
function agedInStatus(status: string, cutoff: Date, incident: string): Prisma.OrderWhereInput {
  return {
    status,
    OR: [
      { statusHistory: { some: { status, occurredAt: { lt: cutoff } } } },
      { statusHistory: { none: { status } }, createdAt: { lt: cutoff } },
    ],
    notificationOutbox: {
      none: { event: NotificationEvent.ORDER_PIPELINE_FAILED, dedupeKey: { contains: `:${incident}:` } },
    },
  };
}

/** When the order last entered `status`, read inside the caller's lock. */
async function enteredStatusAt(db: Db, order: { id: number; createdAt: Date }, status: string): Promise<Date> {
  const row = await db.orderStatusHistory.findFirst({
    where: { orderId: order.id, status },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  return row?.occurredAt ?? order.createdAt;
}

export type UnderpaidNeedsAdminReason = "wallet_topup" | "no_received_amount" | "supplier_may_complete" | "looks_paid";

export type UnderpaidAutoResolveOutcome =
  | { kind: "resolved"; orderCode: string; refunded: Decimal; currency: string }
  | { kind: "skipped"; reason: "not_underpaid" | "not_expired" }
  | { kind: "needs_admin"; orderCode: string; reason: UnderpaidNeedsAdminReason };

const NEEDS_ADMIN_TEXT: Record<UnderpaidNeedsAdminReason, string> = {
  wallet_topup: "it is a wallet top-up, so an admin has to decide how much of the payment to credit",
  no_received_amount: "no payment rail recorded how much actually arrived for it",
  supplier_may_complete: "it was handed to the supplier, which may still complete it",
  looks_paid: "it is marked as paid, so refunding only part of the money could be wrong",
};

/**
 * Resolve one UNDERPAID order if, under its row lock, it is still UNDERPAID,
 * older than `ttlHours`, and safe to refund automatically. Anything else is
 * reported back without a write. A resolution or payment that commits while
 * this waits for the lock wins: the re-read sees the new status and stops.
 */
export async function autoResolveExpiredUnderpaidOrder(
  db: PrismaClient,
  orderId: number,
  opts: { now: Date; ttlHours: number },
): Promise<UnderpaidAutoResolveOutcome> {
  return db.$transaction(async (tx: Tx) => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR NO KEY UPDATE`;
    const order = await getOrderRaw(tx, orderId);
    if (!order || order.status !== OrderStatus.UNDERPAID) return { kind: "skipped", reason: "not_underpaid" } as const;
    const since = await enteredStatusAt(tx, order, OrderStatus.UNDERPAID);
    if (opts.now.getTime() - since.getTime() < opts.ttlHours * HOUR_MS) {
      return { kind: "skipped", reason: "not_expired" } as const;
    }
    const needsAdmin = (reason: UnderpaidNeedsAdminReason) => ({ kind: "needs_admin", orderCode: order.orderCode, reason }) as const;
    if (order.kind === OrderKind.WALLET_TOPUP) return needsAdmin("wallet_topup");
    // Any sign the order reached the supplier keeps it with a human — the
    // dispatcher only picks PROCESSING orders, so this is defensive, but a
    // supplier "Sukses" after a refund would hand the buyer both.
    if (order.digiflazzDispatchedAt != null || order.digiflazzStatus != null || isDigiflazzCreditLocked(order)) {
      return needsAdmin("supplier_may_complete");
    }
    if (order.paidAt != null || order.paymentState === "PAID") return needsAdmin("looks_paid");
    const received = await findUnderpaidReceived(tx, order.id);
    if (received === null || !received.greaterThan(0)) return needsAdmin("no_received_amount");

    let result;
    try {
      result = await refundUnderpaidOrderTx(tx, { orderId: order.id, adminId: null });
    } catch (e) {
      // Cannot happen under the lock held above, but stay a clean skip if it does.
      if (e instanceof ValidationError && e.key === "error.order_not_underpaid") {
        return { kind: "skipped", reason: "not_underpaid" } as const;
      }
      throw e;
    }
    await logAdminAction(tx, {
      adminId: null,
      action: "underpaid_auto_refund",
      targetType: "order",
      targetId: order.id,
      details:
        `Underpaid order ${order.orderCode} stayed unresolved for more than ${opts.ttlHours} hours, so the system ` +
        `refunded the ${result.refunded.toString()} ${result.currency} that arrived to the buyer's balance and ` +
        `released its stock, voucher and wallet credit.`,
    });
    return { kind: "resolved", orderCode: order.orderCode, refunded: result.refunded, currency: result.currency } as const;
  }, { timeout: 15000 });
}

export interface AgedOrderSweepSummary {
  underpaidResolved: number;
  /** Aged UNDERPAID orders left for a human (alerted once when an admin exists). */
  underpaidNeedsAdmin: number;
  /** Aged UNDERPAID orders whose resolution threw; retried next run. */
  underpaidErrored: number;
  /** FAILED orders alerted for the first time in this run. */
  failedAlerted: number;
}

/**
 * One pass over aged UNDERPAID and FAILED orders. Each UNDERPAID order is
 * resolved in its own transaction, so one failure never blocks the rest and is
 * retried next run. Alerts go through `enqueueTransactionReviewAlert`, deduped
 * per order, incident and admin by the outbox's dedupe key; an alerted order
 * is left out of later runs (see `agedInStatus`).
 */
export async function sweepAgedUnderpaidAndFailedOrders(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<AgedOrderSweepSummary> {
  const summary: AgedOrderSweepSummary = { underpaidResolved: 0, underpaidNeedsAdmin: 0, underpaidErrored: 0, failedAlerted: 0 };
  const hasAdmins = (await resolveAdminIds(db)).length > 0;
  let unalertable = 0;

  const underpaidTtl = await getUnderpaidAutoResolveHours(db);
  if (underpaidTtl !== null) {
    const candidates = await db.order.findMany({
      where: agedInStatus(OrderStatus.UNDERPAID, new Date(now.getTime() - underpaidTtl * HOUR_MS), UNDERPAID_INCIDENT),
      select: { id: true, orderCode: true },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
    });
    for (const candidate of candidates) {
      let outcome: UnderpaidAutoResolveOutcome;
      try {
        outcome = await autoResolveExpiredUnderpaidOrder(db, candidate.id, { now, ttlHours: underpaidTtl });
      } catch (err) {
        summary.underpaidErrored++;
        logger.error(
          { err, orderId: candidate.id },
          `Could not resolve aged underpaid order ${candidate.orderCode}; nothing was changed and the next sweep will try again.`,
        );
        continue;
      }
      if (outcome.kind === "resolved") {
        summary.underpaidResolved++;
        logger.info(
          `Underpaid order ${outcome.orderCode} passed the ${underpaidTtl}-hour limit, so the ${outcome.refunded.toString()} ${outcome.currency} that arrived was refunded to the buyer's balance and its stock, voucher and wallet credit were released.`,
        );
      } else if (outcome.kind === "needs_admin") {
        summary.underpaidNeedsAdmin++;
        if (!hasAdmins) {
          unalertable++;
          continue;
        }
        // The order itself was not touched; a failed alert is only retried,
        // never counted as a failed resolution.
        try {
          await enqueueTransactionReviewAlert(db, {
            orderId: candidate.id,
            orderCode: outcome.orderCode,
            reason: `Underpaid for more than ${underpaidTtl} hours and not resolved automatically because ${NEEDS_ADMIN_TEXT[outcome.reason]}. Resolve it from the Payments page.`,
            incident: UNDERPAID_INCIDENT,
          });
          logger.warn(
            `Underpaid order ${outcome.orderCode} passed the ${underpaidTtl}-hour limit but was left for an admin because ${NEEDS_ADMIN_TEXT[outcome.reason]}; the admins were alerted once.`,
          );
        } catch (err) {
          logger.error(
            { err, orderId: candidate.id },
            `Could not queue the admin alert for aged underpaid order ${outcome.orderCode}; the order was left unchanged and the next sweep will try the alert again.`,
          );
        }
      }
    }
  }

  const failedHours = await getFailedOrderAlertHours(db);
  if (failedHours !== null) {
    const aged = await db.order.findMany({
      where: agedInStatus(OrderStatus.FAILED, new Date(now.getTime() - failedHours * HOUR_MS), FAILED_INCIDENT),
      select: { id: true, orderCode: true },
      orderBy: { id: "asc" },
      take: SWEEP_BATCH,
    });
    if (!hasAdmins) {
      unalertable += aged.length;
    } else {
      for (const order of aged) {
        try {
          await enqueueTransactionReviewAlert(db, {
            orderId: order.id,
            orderCode: order.orderCode,
            reason: `Failed more than ${failedHours} hours ago and still holds its stock, voucher and any payment. It is not resolved automatically because it may have been paid in full; check the payment, then cancel, credit or refund it.`,
            incident: FAILED_INCIDENT,
          });
          summary.failedAlerted++;
        } catch (err) {
          logger.error(
            { err, orderId: order.id },
            `Could not queue the aging alert for failed order ${order.orderCode}; the next sweep will try again.`,
          );
        }
      }
      if (summary.failedAlerted > 0) {
        const n = summary.failedAlerted;
        logger.warn(
          `${n} failed ${n === 1 ? "order has" : "orders have"} waited more than ${failedHours} hours without an admin resolving ${n === 1 ? "it" : "them"}; the admins were alerted once for ${n === 1 ? "it" : "each"}.`,
        );
      }
    }
  }

  if (unalertable > 0) {
    logger.warn(
      `${unalertable} aged underpaid or failed ${unalertable === 1 ? "order needs" : "orders need"} an admin, but no admin account is configured to alert, so ${unalertable === 1 ? "it stays" : "they stay"} as ${unalertable === 1 ? "it is" : "they are"} until someone resolves ${unalertable === 1 ? "it" : "them"} from the admin panel.`,
    );
  }
  return summary;
}
