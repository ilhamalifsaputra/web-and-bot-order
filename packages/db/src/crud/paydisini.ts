/**
 * CRUD for the PayDisini (IDR / QRIS / e-wallet) payment path — mirrors
 * crud/tokopay.ts: SQLite has no row locks, so the
 * `processed_paydisini_tx.trx_id` UNIQUE constraint is the idempotency gate.
 * PayDisini retries callbacks; claiming the trx id is an atomic insert and a
 * duplicate insert means "already handled" — an order can never double-deliver.
 *
 * The HTTP/webhook side (signature check, API calls) lives in
 * packages/core/src/payments/paydisini.ts; this module only mutates the DB.
 */
import {
  PAYDISINI_USERKEY_KEY,
  PAYDISINI_APIKEY_KEY,
  PAYDISINI_ENABLED_KEY,
  PAYDISINI_CHANNEL_KEY,
  type PaydisiniCreds,
} from "@app/core/payments/paydisini";
import { OrderStatus, OrderKind, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, settlePaidOrder } from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { enqueueNotification, enqueueAdminOverpaid } from "./notifications";
import { getSetting } from "./settings";
import { parseMinAmount } from "./_minAmount";
import { settleWalletTopup, isLateSettleableWalletTopup } from "./wallet_topup";
import { QRIS_RECLAIMABLE_OUTCOMES } from "./binance_internal";

/** Minimum-payment-amount note shown at checkout (IDR) — blank = no note. */
export const PAYDISINI_MIN_AMOUNT_KEY = "paydisini_min_amount";

/** Read PayDisini gateway credentials from Settings; null = the QRIS/e-wallet path is off. */
export async function getPaydisiniCreds(db: Db): Promise<(PaydisiniCreds & { minAmount: Decimal | null }) | null> {
  const [userKey, apiKey, enabled, channel, minAmountSetting] = await Promise.all([
    getSetting(db, PAYDISINI_USERKEY_KEY),
    getSetting(db, PAYDISINI_APIKEY_KEY),
    getSetting(db, PAYDISINI_ENABLED_KEY),
    getSetting(db, PAYDISINI_CHANNEL_KEY),
    getSetting(db, PAYDISINI_MIN_AMOUNT_KEY),
  ]);
  if (!userKey || !apiKey) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return {
    userKey,
    apiKey,
    channel: (channel ?? "QRIS").trim() || "QRIS",
    minAmount: parseMinAmount(minAmountSetting),
  };
}

/** PENDING, not-yet-expired PayDisini orders the reconcile poller should
 * check, oldest first (closest to auto-cancelling). `limit`, when given,
 * caps how many rows come back — the reconcile poller passes
 * MAX_ORDERS_PER_CYCLE so one cycle's gateway round-trips stay bounded
 * regardless of backlog size (Task 11); omitted, every other caller keeps
 * today's unbounded behavior. */
export function listPendingPaydisiniOrders(db: Db, now: Date, limit?: number) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.PAYDISINI,
      expiresAt: { gt: now },
    },
    include: { user: true },
    orderBy: { createdAt: "asc" },
    ...(limit != null ? { take: limit } : {}),
  });
}

export type PaydisiniDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "processing"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>> }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a PayDisini-paid order. Claims the callback's
 * trx id (UNIQUE gate), then runs the normal approve/deliver path in one
 * transaction. The buyer is notified through the OUTBOX (ORDER_DELIVERED_DM —
 * order code + shop link, never credentials); the web never sends Telegram.
 */
export async function deliverPaidPaydisiniOrder(
  db: PrismaClient,
  args: { orderId: number; trxId: string; amount: Decimal.Value; shopUrl?: string | null },
): Promise<PaydisiniDeliverResult> {
  // 1. Claim the trx id. A duplicate normally means another callback already
  //    handled it — UNLESS the prior claim's outcome is one of
  //    QRIS_RECLAIMABLE_OUTCOMES ("delivery_failed" or "unmatched"): neither
  //    of those ever actually delivered anything, so the trx id must stay
  //    re-claimable, or the buyer's payment is silently lost forever behind a
  //    stuck idempotency row (delivery_failed: H-3, backend audit
  //    2026-07-31; unmatched: Task 15 — PayDisini hands back a trxId scoped
  //    to THIS order's orderCode, so "unmatched" here can only mean this
  //    trxId's own order was temporarily un-matchable, never a guess at some
  //    other order — see QRIS_RECLAIMABLE_OUTCOMES's doc-comment in
  //    binance_internal.ts for why that is NOT true on the amount-matched
  //    crypto rails, which use a narrower set). Re-claiming is a single
  //    atomic UPDATE gated on that outcome set — SQLite serializes writers,
  //    so if two retries race, exactly one `updateMany` sees count=1 and
  //    proceeds; the other sees count=0 and correctly reports
  //    already_processed.
  try {
    await db.processedPaydisiniTx.create({
      data: { trxId: args.trxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const reclaimed = await db.processedPaydisiniTx.updateMany({
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
      // A cancelled WALLET_TOPUP is still payable (isLateSettleableWalletTopup):
      // the buyer paid after the window closed, and a top-up reserves nothing
      // that cancelling gave away. A cancelled PRODUCT order is NOT — its
      // stock went back to the pool — so it keeps falling through to "stale".
      if (
        !order ||
        (order.status !== OrderStatus.PENDING_PAYMENT && !isLateSettleableWalletTopup(order)) ||
        order.paymentMethod !== PaymentMethod.PAYDISINI
      ) {
        // Correct the audit row: the trx matched an order that's no longer payable.
        // Use `tx` (not the outer `db`) — we're still inside db.$transaction, and a
        // second connection writing the same row here would block on SQLite's
        // single-writer lock until the surrounding transaction itself times out.
        await tx.processedPaydisiniTx
          .update({ where: { trxId: args.trxId }, data: { outcome: "stale" } })
          .catch(() => undefined);
        return { status: "stale" as const };
      }
      if (order.kind === OrderKind.WALLET_TOPUP) {
        // Buyer DM (WALLET_TOPUP_CREDITED_DM) is enqueued inside
        // settleWalletTopup itself — the ONE call site for that event across
        // all six top-up rails, behind its own atomic claim. This webhook
        // (running in the web process, which must never send Telegram
        // itself) must not enqueue it again here, or the buyer would be
        // notified twice.
        const { order: settled } = await settleWalletTopup(tx, args.orderId, { amount: args.amount });
        logger.info(`Auto-delivered PayDisini wallet top-up order ${settled.orderCode} for transaction ${args.trxId}`);
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
        await tx.processedPaydisiniTx.update({ where: { trxId: args.trxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: result.order.id,
          orderCode: result.order.orderCode,
          paid: paidAmount,
          expected: order.totalAmount,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `PayDisini order ${result.order.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      if (result.kind === "delivered") {
        logger.info(`Auto-delivered PayDisini order ${result.order.orderCode} for transaction ${args.trxId}`);
        return { status: "delivered" as const, order: result.order, credentials: result.credentials };
      }
      logger.info(`PayDisini order ${result.order.orderCode} paid — queued for manual fulfilment (transaction ${args.trxId})`);
      return { status: "processing" as const, order: result.order };
    }, { timeout: 15000 });
  } catch (e) {
    await db.processedPaydisiniTx
      .update({ where: { trxId: args.trxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** A callback that matched no payable order — record once for manual review. */
export async function recordUnmatchedPaydisiniTx(
  db: Db,
  args: { trxId: string; amount: Decimal.Value },
): Promise<boolean> {
  try {
    await db.processedPaydisiniTx.create({
      data: { trxId: args.trxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
