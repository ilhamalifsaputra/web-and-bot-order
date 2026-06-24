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
import { OrderStatus, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, approveOrder } from "./orders";
import { transitionOrderStatus } from "./orderStatus";
import { enqueueNotification, enqueueAdminOverpaid } from "./notifications";
import { getSetting } from "./settings";
import { parseMinAmount } from "./_minAmount";

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

/** PENDING, not-yet-expired PayDisini orders the reconcile poller should check. */
export function listPendingPaydisiniOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.PAYDISINI,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type PaydisiniDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
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
  // 1. Claim the trx id. A duplicate means another callback already handled it.
  try {
    await db.processedPaydisiniTx.create({
      data: { trxId: args.trxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "already_processed" };
    throw e;
  }

  // 2. Deliver. On failure, flag the ledger row (e.g. paid but out of stock)
  //    so we never retry silently — the caller alerts via logs/admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (
        !order ||
        order.status !== OrderStatus.PENDING_PAYMENT ||
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
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      // Buyer DM via the outbox — only if the buyer has a Telegram account.
      // Web-only buyers (telegramId=null) have no chat to DM; they see their
      // order on the storefront instead. Link only — the outbox payload is
      // visible in the admin /outbox panel, never put credentials in it.
      if (delivered.user.telegramId != null) {
        await enqueueNotification(tx, NotificationEvent.ORDER_DELIVERED_DM, delivered.id, {
          chat_id: Number(delivered.user.telegramId),
          order_code: delivered.orderCode,
          order_url: args.shopUrl ? `${args.shopUrl.replace(/\/+$/, "")}/account/orders/${delivered.orderCode}` : null,
          buyer_language: langCode(delivered.user.language),
        });
      }
      // Overpayment: the buyer paid more than the order total. Still deliver
      // (handled above) but flag the ledger row and alert admins so the
      // excess can be refunded/credited manually — never auto-refunded.
      const paidAmount = new Decimal(args.amount);
      const excess = paidAmount.minus(order.totalAmount);
      if (excess.greaterThan(0)) {
        await tx.processedPaydisiniTx.update({ where: { trxId: args.trxId }, data: { outcome: "overpaid" } });
        await enqueueAdminOverpaid(tx, {
          orderId: delivered.id,
          orderCode: delivered.orderCode,
          paid: paidAmount,
          expected: order.totalAmount,
          excess,
          currency: order.currency,
        });
        logger.warn(
          `PayDisini order ${delivered.orderCode} was overpaid — got ${paidAmount.toString()}, expected ${order.totalAmount.toString()} (excess ${excess.toString()} ${order.currency}) — flagged for manual refund/credit, an admin alert was enqueued`,
        );
      }
      logger.info(`Auto-delivered PayDisini order ${delivered.orderCode} for transaction ${args.trxId}`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
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
