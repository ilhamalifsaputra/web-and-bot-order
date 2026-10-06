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
