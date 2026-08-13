/**
 * CRUD for the NOWPayments (USDT crypto invoice) payment path — mirrors
 * crud/paydisini.ts: SQLite has no row locks, so the
 * `processed_nowpayments_tx.trx_id` UNIQUE constraint is the idempotency gate.
 * NOWPayments retries IPN callbacks; claiming the trx id is an atomic insert
 * and a duplicate insert means "already handled" — an order can never
 * double-deliver.
 *
 * The HTTP/webhook side (signature check, API calls) lives in
 * packages/core/src/payments/nowpayments.ts; this module only mutates the DB.
 */
import {
  NOWPAYMENTS_API_KEY_KEY,
  NOWPAYMENTS_IPN_SECRET_KEY,
  NOWPAYMENTS_ENABLED_KEY,
  NOWPAYMENTS_PAY_CURRENCY_KEY,
  type NowpaymentsCreds,
} from "@app/core/payments/nowpayments";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, settlePaidOrder } from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { enqueueNotification, enqueueAdminOverpaid, enqueueWalletTopupCreditedDm } from "./notifications";
import { getSetting } from "./settings";
import { parseMinAmount } from "./_minAmount";
import { settleWalletTopup } from "./wallet_topup";
import { QRIS_RECLAIMABLE_OUTCOMES } from "./binance_internal";

/** Minimum-payment-amount note shown at checkout (USDT) — blank = no note. */
export const NOWPAYMENTS_MIN_AMOUNT_KEY = "nowpayments_min_amount";

/** Read NOWPayments gateway credentials from Settings; null = the USDT path is off. */
export async function getNowpaymentsCreds(db: Db): Promise<(NowpaymentsCreds & { minAmount: Decimal | null }) | null> {
  const [apiKey, ipnSecret, enabled, payCurrency, minAmountSetting] = await Promise.all([
    getSetting(db, NOWPAYMENTS_API_KEY_KEY),
    getSetting(db, NOWPAYMENTS_IPN_SECRET_KEY),
    getSetting(db, NOWPAYMENTS_ENABLED_KEY),
    getSetting(db, NOWPAYMENTS_PAY_CURRENCY_KEY),
    getSetting(db, NOWPAYMENTS_MIN_AMOUNT_KEY),
  ]);
  if (!apiKey || !ipnSecret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return {
    apiKey,
    ipnSecret,
    payCurrency: (payCurrency ?? "").trim() || "usdttrc20",
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/** PENDING, not-yet-expired NOWPayments orders the reconcile poller should
 * check, oldest first (closest to auto-cancelling). `limit`, when given,
 * caps how many rows come back — the reconcile poller passes
 * MAX_ORDERS_PER_CYCLE so one cycle's gateway round-trips stay bounded
 * regardless of backlog size (Task 11); omitted, every other caller keeps
 * today's unbounded behavior. */
export function listPendingNowpaymentsOrders(db: Db, now: Date, limit?: number) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.NOWPAYMENTS,
      expiresAt: { gt: now },
    },
    include: { user: true },
    orderBy: { createdAt: "asc" },
    ...(limit != null ? { take: limit } : {}),
  });
}

export type NowpaymentsDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a NOWPayments-paid order. Claims the IPN's
 * trx id (UNIQUE gate — NOWPayments' `payment_id`), then runs the normal
 * approve/deliver path in one transaction. The buyer is notified through the
 * OUTBOX (ORDER_DELIVERED_DM — order code + shop link, never credentials);
 * the web never sends Telegram.
 */
export async function deliverPaidNowpaymentsOrder(
  db: PrismaClient,
  args: { orderId: number; trxId: string; amount: Decimal.Value; shopUrl?: string | null },
): Promise<NowpaymentsDeliverResult> {
  // 1. Claim the trx id. A duplicate normally means another callback already
  //    handled it — UNLESS the prior claim's outcome is one of
  //    QRIS_RECLAIMABLE_OUTCOMES ("delivery_failed" or "unmatched"): neither
  //    of those ever actually delivered anything, so the trx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (delivery_failed: H-3, backend audit
  //    2026-07-31; unmatched: Task 15 — NOWPayments hands back a trxId
  //    scoped to THIS order's orderCode, so "unmatched" here can only mean
  //    this trxId's own order was temporarily un-matchable, never a guess at
  //    some other order — see QRIS_RECLAIMABLE_OUTCOMES's doc-comment in
  //    binance_internal.ts for why that is NOT true on the amount-matched
  //    crypto rails, which use a narrower set). Re-claiming is a single
  //    atomic UPDATE gated on that outcome set — SQLite serializes writers,
  //    so if two retries race, exactly one `updateMany` sees count=1 and
  //    proceeds; the other sees count=0 and correctly reports
  //    already_processed.
  try {
    await db.processedNowpaymentsTx.create({
      data: { trxId: args.trxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const reclaimed = await db.processedNowpaymentsTx.updateMany({
      where: { trxId: args.trxId, outcome: { in: [...QRIS_RECLAIMABLE_OUTCOMES] } },
      data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
    if (reclaimed.count === 0) return { status: "already_processed" };
  }

  // 2. Deliver. On failure, flag the ledger row (e.g. paid but out of stock)
  //    so we never retry silently — the caller alerts via logs/admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (
        !order ||
        order.status !== OrderStatus.PENDING_PAYMENT ||
        order.paymentMethod !== PaymentMethod.NOWPAYMENTS
      ) {
        // Correct the audit row: the trx matched an order that's no longer payable.
        // Use `tx` (not the outer `db`) — we're still inside db.$transaction, and a
        // second connection writing the same row here would block on SQLite's
        // single-writer lock until the surrounding transaction itself times out.
        await tx.processedNowpaymentsTx
          .update({ where: { trxId: args.trxId }, data: { outcome: "stale" } })
          .catch(() => undefined);
        return { status: "stale" as const };
      }
      if (order.kind === OrderKind.WALLET_TOPUP) {
        const { order: settled, credited, newBalance } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        // Buyer DM via the outbox — this settlement runs in the web process
        // (a NOWPayments IPN webhook), which must never send Telegram
        // itself. Guarded on credited > 0 so the rare double-settlement
        // no-op never enqueues a second DM for an already-notified top-up.
        if (credited.greaterThan(0) && settled.user.telegramId != null) {
          await enqueueWalletTopupCreditedDm(tx, {
            orderId: settled.id,
            chatId: Number(settled.user.telegramId),
            amount: credited,
            currency: settled.currency,
            newBalance,
          });
        }
        logger.info(`Auto-delivered NOWPayments wallet top-up order ${settled.orderCode} for transaction ${args.trxId}`);
        return { status: "delivered" as const, order: settled, credentials: [] };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { paidAt: new Date() },
      });
      await transitionOrderStatus(tx, {
        orderId: args.orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.PENDING_VERIFICATION,
        meta: `trxId=${args.trxId}`,
      });
      const result = await settlePaidOrder(tx, args.orderId, { adminId: 0 });
      // Buyer DM via the outbox — only if the buyer has a Telegram account.
      // Web-only buyers (telegramId=null) have no chat to DM; they see their
      // order on the storefront instead. Link only — the outbox payload is
      // visible in the admin /outbox panel, never put credentials in it.
      // Skipped for a "processing" result — settlePaidOrder already enqueued
      // the buyer's ORDER_PROCESSING_DM for manual-fulfilment SKUs.
      if (result.kind === "delivered" && result.order.user.telegramId != null) {
        await enqueueNotification(tx, NotificationEvent.ORDER_DELIVERED_DM, result.order.id, {
          chat_id: Number(result.order.user.telegramId),
          order_code: result.order.orderCode,
          order_url: args.shopUrl ? `${args.shopUrl.replace(/\/+$/, "")}/account/orders/${result.order.orderCode}` : null,
          buyer_language: langCode(result.order.user.language),
        });
      }
      // Overpayment: the buyer paid more than the order total. Still deliver
      // (handled above) but flag the ledger row and alert admins so the
      // excess can be refunded/credited manually — never auto-refunded. This
      // stays unconditional — a buyer can overpay regardless of delivery type.
      const paidAmount = new Decimal(args.amount);
      const excess = paidAmount.minus(order.totalAmount);
      if (excess.greaterThan(0)) {
        await tx.processedNowpaymentsTx.update({ where: { trxId: args.trxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: result.order.id,
          orderCode: result.order.orderCode,
          paid: paidAmount,
          expected: order.totalAmount,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `NOWPayments order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(`Auto-delivered NOWPayments order ${result.order.orderCode} for transaction ${args.trxId}`);
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(`NOWPayments order ${result.order.orderCode} paid — queued for manual fulfilment (transaction ${args.trxId})`);
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedNowpaymentsTx
      .update({ where: { trxId: args.trxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** A callback that matched no payable order — record once for manual review. */
export async function recordUnmatchedNowpaymentsTx(
  db: Db,
  args: { trxId: string; amount: Decimal.Value },
): Promise<boolean> {
  try {
    await db.processedNowpaymentsTx.create({
      data: { trxId: args.trxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
