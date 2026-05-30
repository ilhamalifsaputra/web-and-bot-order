/**
 * CRUD for the Binance Internal Transfer (UID-based) payment method.
 *
 * Idempotency on SQLite: there is no `SELECT ... FOR UPDATE`. Instead, the
 * `processed_binance_tx.binance_tx_id` UNIQUE constraint is the concurrency
 * gate — claiming a tx id is an atomic insert; a duplicate insert throws and is
 * treated as "already processed". Combined with SQLite's single-writer
 * serialization + busy_timeout, this prevents double-delivery without locks.
 */
import { config } from "@app/core/config";
import { OrderStatus, PaymentMethod } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { addMinutes } from "@app/core/datetime";
import { generatePaymentRef } from "@app/core/formatters";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, createOrderDirect, approveOrder } from "./orders";

/** Create a direct order, then mark it BINANCE_INTERNAL with a unique note + 15-min expiry. */
export async function createInternalOrder(
  db: Db,
  args: { user: { id: number; role: string }; productId: number; quantity: number; voucherCode?: string | null },
) {
  const created = await createOrderDirect(db, args);
  if (!created) return null;

  // Pick a payment ref free of (the astronomically unlikely) collision.
  let ref = generatePaymentRef();
  for (let i = 0; i < 5; i++) {
    const clash = await db.order.findUnique({ where: { paymentRef: ref } });
    if (!clash) break;
    ref = generatePaymentRef();
  }

  await db.order.update({
    where: { id: created.id },
    data: {
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentRef: ref,
      expiresAt: addMinutes(new Date(), config.INTERNAL_PAYMENT_WINDOW_MINUTES),
    },
  });
  return getOrder(db, created.id);
}

/** Remember which message holds the payment instructions, so the poller can edit it. */
export async function setOrderPaymentMessage(db: Db, orderId: number, chatId: number | bigint, messageId: number) {
  await db.order.update({
    where: { id: orderId },
    data: { paymentMsgChatId: BigInt(chatId), paymentMsgId: messageId },
  });
}

/** PENDING, not-yet-expired internal-transfer orders the poller should match against. */
export function listPendingInternalOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.BINANCE_INTERNAL,
      paymentRef: { not: null },
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type DeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
  | { status: "already_processed" }
  | { status: "stale" };

/**
 * Idempotently confirm + deliver a matched internal-transfer order.
 * Claims the Binance tx id (UNIQUE gate) then runs the normal approve/deliver
 * path. Returns "already_processed" if the tx was seen before, "stale" if the
 * order is no longer awaiting payment (delivered/expired elsewhere).
 */
export async function deliverPaidInternalOrder(
  db: PrismaClient,
  args: { orderId: number; binanceTxId: string; amount: Decimal.Value },
): Promise<DeliverResult> {
  // 1. Claim the tx id. A duplicate means another cycle already handled it.
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "matched" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { status: "already_processed" };
    throw e;
  }

  // 2. Deliver. On failure, flag the ledger row so we don't silently retry
  //    forever (e.g. paid but out of stock) and let the caller alert an admin.
  try {
    return await db.$transaction(async (tx: Tx) => {
      const order = await getOrder(tx, args.orderId);
      if (!order || order.status !== OrderStatus.PENDING_PAYMENT) {
        return { status: "stale" as const };
      }
      await tx.order.update({
        where: { id: args.orderId },
        data: { status: OrderStatus.PENDING_VERIFICATION, binanceTxid: args.binanceTxId, paidAt: new Date() },
      });
      const { order: delivered, credentials } = await approveOrder(tx, args.orderId, { adminId: 0 });
      logger.info(`Auto-delivered internal-transfer order ${delivered.orderCode} (tx ${args.binanceTxId})`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
  } catch (e) {
    await db.processedBinanceTx
      .update({ where: { binanceTxId: args.binanceTxId }, data: { outcome: "delivery_failed" } })
      .catch(() => undefined);
    throw e;
  }
}

/** Note matched but amount short: flag UNDERPAID for admin review (idempotent). */
export async function markUnderpaid(
  db: Db,
  args: { orderId: number; binanceTxId: string; amount: Decimal.Value },
): Promise<boolean> {
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, orderId: args.orderId, amount: new Decimal(args.amount), outcome: "underpaid" },
    });
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
  await db.order.update({
    where: { id: args.orderId },
    data: {
      status: OrderStatus.UNDERPAID,
      binanceTxid: args.binanceTxId,
      adminNote: `[underpaid] received ${new Decimal(args.amount).toString()} via tx ${args.binanceTxId}`,
    },
  });
  return true;
}

/** A transfer that matched no PENDING order — record once for manual review. */
export async function recordUnmatchedTx(db: Db, args: { binanceTxId: string; amount: Decimal.Value }): Promise<boolean> {
  try {
    await db.processedBinanceTx.create({
      data: { binanceTxId: args.binanceTxId, amount: new Decimal(args.amount), outcome: "unmatched" },
    });
    return true;
  } catch (e) {
    if (isUniqueViolation(e)) return false;
    throw e;
  }
}
