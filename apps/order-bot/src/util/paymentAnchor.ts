/**
 * Persist the transaction screen once. The durable coordinator owns it across
 * payment, fulfillment and wallet credit; navigation opens a separate menu.
 * Legacy untracked screens can still release their temporary menu anchors.
 */
import { prisma, setOrderPaymentMessage, clearPaymentMessageAnchorsAt, adoptTransactionMessage, type TransactionMessageKind } from "@app/db";
import { logger } from "@app/core/logger";
import type { MyContext } from "../context";

/**
 * The kind of message this chat's menu bubble is after a `smartEdit` render.
 * smartEdit edits a tapped photo bubble's caption in place, so a "text" render
 * still leaves a photo when the buyer tapped one (e.g. a banner screen) and the
 * edit landed; any fresh send it makes is text. A QR photo sent by the caller
 * itself is known to be a photo and should be passed as such directly.
 * `messageId` defaults to the session's menu bubble.
 */
export function menuBubbleKind(ctx: MyContext, messageId: number | undefined = ctx.session.menuMsgId): TransactionMessageKind {
  const tapped = ctx.callbackQuery?.message;
  const photo = !!tapped && "photo" in tapped && !!tapped.photo;
  return photo && messageId !== undefined && tapped.message_id === messageId ? "photo" : "text";
}

/**
 * The kind of a QR payment screen once its send settled: "photo" when the QR
 * photo the caller sent (`qrPhotoId`) is still the menu bubble, otherwise the
 * text fallback's kind (see {@link menuBubbleKind}).
 */
export function qrScreenKind(ctx: MyContext, qrPhotoId: number | undefined): TransactionMessageKind {
  return qrPhotoId !== undefined && qrPhotoId === ctx.session.menuMsgId ? "photo" : menuBubbleKind(ctx);
}

/**
 * Point an order's payment-message anchor at this chat's menu bubble and
 * remember, in the session, that the bubble is now anchored. `kind` is the
 * kind of message that bubble actually is ("photo" for a QR photo+caption
 * screen), stored so the worker never edits a photo as text.
 *
 * A no-op when the chat has no menu bubble yet: there is no message to anchor,
 * and writing a pointer to a message id we don't have would be a lie. Callers
 * therefore no longer need their own `if (ctx.session.menuMsgId)` guard.
 */
export async function anchorPaymentMessage(
  ctx: MyContext,
  orderId: number,
  chatId: number | bigint,
  kind: TransactionMessageKind,
): Promise<void> {
  const messageId = ctx.session.menuMsgId;
  if (messageId === undefined) return;
  const canonicalMessageId = await prisma.$transaction(async tx => {
    await adoptTransactionMessage(tx, orderId, chatId, messageId, kind);
    const canonical = await tx.fulfillmentMessage.findUniqueOrThrow({ where: { orderId } });
    await setOrderPaymentMessage(tx, orderId, canonical.chatId, canonical.messageId!);
    return canonical.messageId!;
  });
  ctx.session.paymentAnchorMsgId = canonicalMessageId;
}

/**
 * Release the anchor on a message that a menu render has just overwritten.
 *
 * Gated purely on the session stamp — see this module's header for why a
 * database lookup per render is not affordable. The stamp is dropped
 * unconditionally, before the database is touched: the bubble now shows a
 * menu either way, so this chat has nothing left to release even if the
 * statement below clears no rows.
 *
 * `keepOnChainTracked` is passed because THIS caller is the navigate-away
 * path: a Bybit BSC order in PAYMENT_DETECTED/CONFIRMING/CONFIRMED still has
 * a live tracker that will re-render this bubble on its next cycle, so its
 * claim stays truthful in a way an overtaken bubble's never is. The takeover
 * path (`setOrderPaymentMessage`) deliberately does NOT pass it — see that
 * function for why keeping the exemption there destroys deposit addresses.
 *
 * Failure is swallowed with a warning: the Telegram edit has already
 * happened, so throwing here would deny the buyer the screen they tapped for
 * in exchange for nothing. The cost of the miss is a stale anchor — the same
 * state this whole mechanism exists to clean up, which the next takeover of
 * the bubble will clear anyway.
 */
export async function releasePaymentAnchorIfReused(ctx: MyContext, messageId: number): Promise<void> {
  if (ctx.session.paymentAnchorMsgId !== messageId) return;
  const chatId = ctx.chat?.id;
  ctx.session.paymentAnchorMsgId = undefined;
  if (chatId === undefined) return;
  try {
    await clearPaymentMessageAnchorsAt(prisma, chatId, messageId, { keepOnChainTracked: true });
  } catch (err) {
    logger.warn(
      { err, chatId, messageId },
      `Could not release the payment-message anchor on the bubble that was just re-rendered as a menu in chat ${chatId}. The order still claims a message that no longer shows its payment instructions, so a poller or the settled-bubble sweeper may overwrite whatever the buyer navigated to; the next checkout that reuses this bubble will clear the claim.`,
    );
  }
}
