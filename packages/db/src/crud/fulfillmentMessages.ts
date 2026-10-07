import { OrderKind } from "@app/core/enums";
import type { Db } from "./_types";

/**
 * Register the buyer's single Telegram progress message for an order. The
 * outbox-dispatcher's FulfillmentMessageWorker sends it once and then edits
 * that same message from the order's canonical state.
 *
 * Call only at a canonical moment: a real "payment seen" transition or a
 * settled payment. Idempotent (`update: {}`), so a replayed webhook or a later
 * phase reuses the existing row and therefore the existing message. Returns
 * false for buyers without a Telegram chat (web-only shoppers) and for
 * wallet top-ups.
 */
export async function ensureFulfillmentMessage(db: Db, orderId: number): Promise<boolean> {
  const order = await db.order.findUnique({ where: { id: orderId }, select: { kind: true, user: { select: { telegramId: true } } } });
  const chatId = order?.user.telegramId;
  // Wallet top-ups have their own settled bubble and no product to fulfil.
  if (chatId == null || order!.kind !== OrderKind.PRODUCT) return false;
  await db.fulfillmentMessage.upsert({ where: { orderId }, create: { orderId, chatId }, update: {} });
  return true;
}

/**
 * Bring an order's progress message forward when the order reaches a final
 * state, so the buyer sees the outcome promptly. Call it in the same
 * transaction as the status write.
 *
 * A manual order's static WAITING line is never polled (it would wait for
 * hours), so this is the only thing that moves it on: it becomes due as an
 * ACTIVE row and the worker edits it to the final text. REVIEW rows are
 * brought forward too. A row the worker holds right now (EDITING) only gets
 * its due time touched: that write takes the row lock, so the worker's own
 * save waits for this transaction and then re-reads the order (see the
 * worker's WAITING re-check). Rows that never got a message, finished rows
 * and flood-control backoffs are left alone.
 */
export async function wakeFulfillmentMessage(db: Db, orderId: number, now: Date = new Date()): Promise<void> {
  await db.fulfillmentMessage.updateMany({
    where: { orderId, state: "WAITING" },
    data: { state: "ACTIVE", nextUpdateAt: now },
  });
  await db.fulfillmentMessage.updateMany({
    where: { orderId, state: { in: ["REVIEW", "EDITING"] } },
    data: { nextUpdateAt: now },
  });
}
