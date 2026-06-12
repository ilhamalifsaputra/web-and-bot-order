/**
 * CRUD for the TokoPay (IDR / QRIS / VA) payment path — plan.md §15.5.
 *
 * Mirrors crud/binance_internal.ts: SQLite has no row locks, so the
 * `processed_tokopay_tx.trx_id` UNIQUE constraint is the idempotency gate.
 * TokoPay retries callbacks; claiming the trx id is an atomic insert and a
 * duplicate insert means "already handled" — an order can never double-deliver.
 *
 * The HTTP/webhook side (signature check, API calls) lives in the storefront
 * (apps/storefront/src/payments/tokopay.ts); this module only mutates the DB.
 */
import { OrderStatus, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, approveOrder } from "./orders";
import { enqueueNotification } from "./notifications";

export type TokopayDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
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
  // 1. Claim the trx id. A duplicate means another callback already handled it.
  try {
    await db.processedTokopayTx.create({
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
        order.paymentMethod !== PaymentMethod.TOKOPAY
      ) {
        // Correct the audit row: the trx matched an order that's no longer payable.
        await db.processedTokopayTx
          .update({ where: { trxId: args.trxId }, data: { outcome: "stale" } })
          .catch(() => undefined);
        return { status: "stale" as const };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { status: OrderStatus.PENDING_VERIFICATION, binanceTxid: null, paidAt: new Date() },
      });
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      // Buyer DM via the outbox, same tx as the status flip. Link only — the
      // outbox payload is visible in the admin /outbox panel, never put
      // credentials in it.
      await enqueueNotification(tx, NotificationEvent.ORDER_DELIVERED_DM, delivered.id, {
        chat_id: Number(delivered.user.telegramId),
        order_code: delivered.orderCode,
        order_url: args.shopUrl ? `${args.shopUrl.replace(/\/+$/, "")}/account/orders/${delivered.orderCode}` : null,
        buyer_language: langCode(delivered.user.language),
      });
      logger.info(`Auto-delivered TokoPay order ${delivered.orderCode} (trx ${args.trxId})`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
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
