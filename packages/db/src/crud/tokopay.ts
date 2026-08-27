/**
 * CRUD for the TokoPay (IDR / QRIS / VA) payment path — plan.md §15.5.
 *
 * Mirrors crud/binance_internal.ts: SQLite has no row locks, so the
 * `processed_tokopay_tx.trx_id` UNIQUE constraint is the idempotency gate.
 * TokoPay retries callbacks; claiming the trx id is an atomic insert and a
 * duplicate insert means "already handled" — an order can never double-deliver.
 *
 * The HTTP/webhook side (signature check, API calls) lives in
 * packages/core/src/payments/tokopay.ts; this module only mutates the DB.
 */
import {
  TOKOPAY_MERCHANT_KEY,
  TOKOPAY_SECRET_KEY,
  TOKOPAY_ENABLED_KEY,
  TOKOPAY_CHANNEL_KEY,
  qrisChargeAmount,
  type TokopayCreds,
} from "@app/core/payments/tokopay";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import { PaymentLogEvent } from "@app/core/payments/logEvents";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, settlePaidOrder } from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { enqueueNotification, enqueueAdminOverpaid } from "./notifications";
import { getSetting, getDecryptedSetting } from "./settings";
import { parseMinAmount } from "./_minAmount";
import { settleWalletTopup, isLateSettleableWalletTopup } from "./wallet_topup";
import { QRIS_RECLAIMABLE_OUTCOMES } from "./binance_internal";
import { getPendingPaymentAttempt, confirmPaymentAttempt } from "./payments";

/** Minimum-payment-amount note shown at checkout (IDR) — blank = no note. */
export const TOKOPAY_MIN_AMOUNT_KEY = "tokopay_min_amount";

/** Read TokoPay gateway credentials from Settings; null = the IDR/QRIS path is off. */
export async function getTokopayCreds(db: Db): Promise<(TokopayCreds & { minAmount: Decimal | null }) | null> {
  const [merchantId, secret, enabled, channel, minAmountSetting] = await Promise.all([
    getSetting(db, TOKOPAY_MERCHANT_KEY),
    getDecryptedSetting(db, TOKOPAY_SECRET_KEY),
    getSetting(db, TOKOPAY_ENABLED_KEY),
    getSetting(db, TOKOPAY_CHANNEL_KEY),
    getSetting(db, TOKOPAY_MIN_AMOUNT_KEY),
  ]);
  if (!merchantId || !secret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return {
    merchantId,
    secret,
    channel: (channel ?? "QRIS").trim() || "QRIS",
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/** PENDING, not-yet-expired TokoPay orders the reconcile poller should check,
 * oldest first (closest to auto-cancelling). `limit`, when given, caps how
 * many rows come back — the reconcile poller passes MAX_ORDERS_PER_CYCLE so
 * one cycle's gateway round-trips stay bounded regardless of backlog size
 * (Task 11); omitted, every other caller keeps today's unbounded behavior. */
export function listPendingTokopayOrders(db: Db, now: Date, limit?: number) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.TOKOPAY,
      expiresAt: { gt: now },
    },
    include: { user: true },
    orderBy: { createdAt: "asc" },
    ...(limit != null ? { take: limit } : {}),
  });
}

export type TokopayDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a TokoPay-paid order. Claims the callback's
 * trx id (UNIQUE gate), then runs the normal approve/deliver path in one
 * transaction. The buyer is notified through the OUTBOX (ORDER_DELIVERED_DM —
 * order code + shop link, never credentials); the web never sends Telegram.
 */
export async function deliverPaidTokopayOrder(
  db: PrismaClient,
  args: { orderId: number; trxId: string; amount: Decimal.Value; shopUrl?: string | null },
): Promise<TokopayDeliverResult> {
  // 1. Claim the trx id. A duplicate normally means another callback already
  //    handled it — UNLESS the prior claim's outcome is one of
  //    QRIS_RECLAIMABLE_OUTCOMES ("delivery_failed" or "unmatched"): neither
  //    of those ever actually delivered anything, so the trx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (delivery_failed: H-3, backend audit
  //    2026-07-31; unmatched: Task 15 — TokoPay hands back a trxId scoped to
  //    THIS order's orderCode, so "unmatched" here can only mean this trxId's
  //    own order was temporarily un-matchable, never a guess at some other
  //    order — see QRIS_RECLAIMABLE_OUTCOMES's doc-comment in
  //    binance_internal.ts for why that is NOT true on the amount-matched
  //    crypto rails, which use a narrower set). Re-claiming is a single
  //    atomic UPDATE gated on that outcome set — SQLite serializes writers,
  //    so if two retries race, exactly one `updateMany` sees count=1 and
  //    proceeds; the other sees count=0 and correctly reports
  //    already_processed.
  try {
    await db.processedTokopayTx.create({
      data: { trxId: args.trxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const reclaimed = await db.processedTokopayTx.updateMany({
      where: { trxId: args.trxId, outcome: { in: [...QRIS_RECLAIMABLE_OUTCOMES] } },
      data: { orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
    if (reclaimed.count === 0) {
      // The idempotency gate working, not a fault: this payment was already
      // settled by whichever of the webhook or the reconcile poller got here
      // first. Logged at info for exactly that reason — see PaymentLogEvent
      // (@app/core/payments/logEvents) on why an expected race is never a warning.
      logger.info(
        {
          event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.TOKOPAY,
          providerPaymentId: args.trxId,
          status: "already_processed",
        },
        `Skipped settling TokoPay transaction ${args.trxId} for order ${args.orderId} because it had already been processed — the ledger claim was lost to whichever path confirmed this payment first, so nothing was delivered or credited twice`,
      );
      return { status: "already_processed" };
    }
  }

  // 2. Deliver. On failure, flag the ledger row (e.g. paid but out of stock)
  //    so we never retry silently — the caller alerts via logs/admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      // A cancelled WALLET_TOPUP is still payable (isLateSettleableWalletTopup):
      // the buyer paid after the window closed, and a top-up reserves nothing
      // that cancelling gave away. A cancelled PRODUCT order is NOT — its
      // stock went back to the pool — so it keeps falling through to "stale".
      if (
        !order ||
        (order.status !== OrderStatus.PENDING_PAYMENT && !isLateSettleableWalletTopup(order)) ||
        order.paymentMethod !== PaymentMethod.TOKOPAY
      ) {
        // Correct the audit row: the trx matched an order that's no longer payable.
        // Use `tx` (not the outer `db`) — we're still inside db.$transaction, and a
        // second connection writing the same row here would block on SQLite's
        // single-writer lock until the surrounding transaction itself times out.
        await tx.processedTokopayTx
          .update({ where: { trxId: args.trxId }, data: { outcome: "stale" } })
          .catch(() => undefined);
        logger.info(
          {
            event: PaymentLogEvent.PAYMENT_ALREADY_CONFIRMED,
            orderId: args.orderId,
            provider: PaymentMethod.TOKOPAY,
            providerPaymentId: args.trxId,
            status: "stale",
          },
          `Did not settle TokoPay transaction ${args.trxId} because order ${args.orderId} is no longer payable — it was cancelled, already settled, or is not a TokoPay order, so the ledger row is marked stale and a human decides what the payment was for`,
        );
        return { status: "stale" as const };
      }
      // Trustance Phase A Task A2b: look up this order's own PENDING Payment
      // ledger row (if any) BEFORE settling, so both branches below can
      // confirm it once delivery actually succeeds. May legitimately be null
      // — orders created before this ledger was wired up, or a rail change
      // that left no PENDING row — and that is never treated as an error.
      const pendingPayment = await getPendingPaymentAttempt(tx, args.orderId).catch(() => null);
      if (order.kind === OrderKind.WALLET_TOPUP) {
        // Buyer DM (WALLET_TOPUP_CREDITED_DM) is enqueued inside
        // settleWalletTopup itself — the ONE call site for that event across
        // all six top-up rails, behind its own atomic claim. This webhook
        // (running in the web process, which must never send Telegram
        // itself) must not enqueue it again here, or the buyer would be
        // notified twice.
        const { order: settled } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        if (pendingPayment) {
          // Best-effort, never blocking: the wallet credit above already
          // committed, so a ledger-only failure here must not roll back a
          // real settlement. See this file's Task A2b comments for why.
          await confirmPaymentAttempt(tx, { paymentId: pendingPayment.id }).catch((err) =>
            logger.warn({ err }, `Could not confirm the Payment ledger row for order ${settled.orderCode} — the order is fully settled and unaffected; this only leaves that ledger row stuck PENDING for manual reconciliation`),
          );
        }
        logger.info(
        {
          event: PaymentLogEvent.PAYMENT_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.TOKOPAY,
          providerPaymentId: args.trxId,
          status: "delivered",
        },
        `Settled TokoPay wallet top-up order ${settled.orderCode} for transaction ${args.trxId} — the buyer's balance was credited and their notification queued`,
        );
        return { status: "delivered" as const, order: settled, credentials: [] };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { binanceTxid: null, paidAt: new Date() },
      });
      await transitionOrderStatus(tx, {
        orderId: args.orderId,
        from: OrderStatus.PENDING_PAYMENT,
        to: OrderStatus.PENDING_VERIFICATION,
        meta: `trxId=${args.trxId}`,
      });
      const result = await settlePaidOrder(tx, args.orderId, { adminId: 0 });
      if (pendingPayment) {
        // Best-effort, never blocking — see the WALLET_TOPUP branch above.
        await confirmPaymentAttempt(tx, { paymentId: pendingPayment.id }).catch((err) =>
          logger.warn({ err }, `Could not confirm the Payment ledger row for order ${result.order.orderCode} — the order is fully settled and unaffected; this only leaves that ledger row stuck PENDING for manual reconciliation`),
        );
      }
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
      const expectedCharge = qrisChargeAmount(order.totalAmount);
      const excess = paidAmount.minus(expectedCharge);
      if (excess.greaterThan(0)) {
        await tx.processedTokopayTx.update({ where: { trxId: args.trxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: result.order.id,
          orderCode: result.order.orderCode,
          paid: paidAmount,
          expected: expectedCharge,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `TokoPay order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${expectedCharge.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(
        {
          event: PaymentLogEvent.PAYMENT_CONFIRMED,
          orderId: args.orderId,
          provider: PaymentMethod.TOKOPAY,
          providerPaymentId: args.trxId,
          status: "delivered",
        },
        `Auto-delivered TokoPay order ${result.order.orderCode} for transaction ${args.trxId}`,
        );
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(
      {
        event: PaymentLogEvent.PAYMENT_CONFIRMED,
        orderId: args.orderId,
        provider: PaymentMethod.TOKOPAY,
        providerPaymentId: args.trxId,
        status: "processing",
      },
      `TokoPay order ${result.order.orderCode} paid — queued for manual fulfilment (transaction ${args.trxId})`,
      );
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedTokopayTx
      .update({ where: { trxId: args.trxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** A callback that matched no payable order — record once for manual review. */
export async function recordUnmatchedTokopayTx(
  db: Db,
  args: { trxId: string; amount: Decimal.Value },
): Promise<boolean> {
  try {
    await db.processedTokopayTx.create({
      data: { trxId: args.trxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
