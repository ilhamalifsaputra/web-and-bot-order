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
import { OrderStatus, PaymentMethod, NotificationEvent, langCode } from "@app/core/enums";
import { Decimal } from "@app/core/money";
import { logger } from "@app/core/logger";
import type { PrismaClient, Tx } from "../client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { getOrder, approveOrder } from "./orders";
import { enqueueNotification } from "./notifications";
import { getSetting } from "./settings";

/** Read NOWPayments gateway credentials from Settings; null = the USDT path is off. */
export async function getNowpaymentsCreds(db: Db): Promise<NowpaymentsCreds | null> {
  const [apiKey, ipnSecret, enabled, payCurrency] = await Promise.all([
    getSetting(db, NOWPAYMENTS_API_KEY_KEY),
    getSetting(db, NOWPAYMENTS_IPN_SECRET_KEY),
    getSetting(db, NOWPAYMENTS_ENABLED_KEY),
    getSetting(db, NOWPAYMENTS_PAY_CURRENCY_KEY),
  ]);
  if (!apiKey || !ipnSecret) return null;
  if ((enabled ?? "").trim().toLowerCase() === "false") return null;
  return { apiKey, ipnSecret, payCurrency: (payCurrency ?? "").trim() || "usdttrc20" };
}

/** PENDING, not-yet-expired NOWPayments orders the reconcile poller should check. */
export function listPendingNowpaymentsOrders(db: Db, now: Date) {
  return db.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      paymentMethod: PaymentMethod.NOWPAYMENTS,
      expiresAt: { gt: now },
    },
    include: { user: true },
  });
}

export type NowpaymentsDeliverResult =
  | { status: "delivered"; order: NonNullable<Awaited<ReturnType<typeof getOrder>>>; credentials: string[] }
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
  // 1. Claim the trx id. A duplicate means another callback already handled it.
  try {
    await db.processedNowpaymentsTx.create({
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
      await tx.order.update({
        where: { id: args.orderId },
        data: { status: OrderStatus.PENDING_VERIFICATION, paidAt: new Date() },
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
      logger.info(`Auto-delivered NOWPayments order ${delivered.orderCode} (trx ${args.trxId})`);
      return { status: "delivered" as const, order: delivered, credentials };
    });
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
