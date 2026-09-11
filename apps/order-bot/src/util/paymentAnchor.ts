/**
 * The payment-message anchor, seen from the bot side.
 *
 * An anchor is a row-level pointer (`order.paymentMsgChatId` /
 * `paymentMsgId`) meaning "this Telegram message still shows THIS order's
 * payment instructions". Pollers and the settled-bubble sweeper act on it by
 * editing that message, so an anchor that no longer describes what the buyer
 * is looking at is actively destructive: the sweeper would flip a bubble to
 * "payment received — order A" on top of order B's still-unpaid deposit
 * address and amount.
 *
 * Every payment screen is rendered into the chat's ONE menu bubble
 * (`ctx.session.menuMsgId`), which the very next tap re-renders in place, so
 * an anchor goes stale in exactly two ways:
 *
 *   (a) a second checkout takes the bubble over for a new order — handled
 *       inside `setOrderPaymentMessage` (packages/db), which clears every
 *       other order's claim on the message it just claimed;
 *   (b) the buyer simply navigates away and the bubble becomes a menu —
 *       handled here, by {@link releasePaymentAnchorIfReused}, called after a
 *       successful edit by `smartEdit` and by `renderMenu`'s edit-caption
 *       branch (util/chat.ts) — the two render paths that leave the existing
 *       bubble alive with menu content in it.
 *
 * The wizard helper `editAnchor` (and `menuAnchor` through it) edits
 * `ctx.session.menuMsgId` in place with no release at all. That is a latent
 * gap, not a live bug: every wizard that could render over a payment screen
 * enters through a callback (so it goes to `smartEdit`), the two typed-input
 * modes are cleared whenever a payment screen renders, and `/support` draws
 * its first screen through `smartEdit`. No live path reaches `editAnchor`
 * with an anchor outstanding, so it deliberately carries no release.
 *
 * The fresh-send branches are also silent on purpose: when an edit fails and
 * we send a NEW message instead, the old bubble still displays the payment
 * instructions, so the anchor still describes reality and must survive.
 *
 * `ctx.session.paymentAnchorMsgId` is the cheap side of (b). The anchor
 * columns are unindexed, so asking the database "is this message anchored?"
 * is a full table scan — unaffordable on `smartEdit`, which runs on nearly
 * every button tap. The session stamp answers that question for free: only a
 * chat that anchored a message in this session, re-rendering that exact
 * message, is allowed to reach the database at all.
 *
 * What that gate costs when it leaks: session storage is Prisma-backed
 * (`prismaSessionStorage`, util/prismaSessionStorage.ts) with TTL-based
 * expiry rather than the old in-memory LRU `Map`, so `paymentAnchorMsgId`
 * now survives a process restart — a deploy no longer reopens this gap by
 * itself. It still expires on its own: `paymentAnchorMsgId` being set is one
 * of the signals `prismaSessionStorage.ts`'s `classifySessionKind` uses to
 * put a session in the "checkout" TTL bucket (see that file) — the longest
 * configured payment window across every rail plus a 5-minute margin (35
 * minutes at default config, deliberately never shorter than a payment that
 * could still be legitimately pending), so a genuinely abandoned session
 * still drops the stamp and reopens case (b) for it — just bounded to that
 * window instead of "until the next restart or LRU eviction, which could be
 * days." This is accepted because of what is and isn't at
 * risk: case (a) — the only one that can destroy money, by pointing two
 * orders at one bubble — is enforced entirely in the database inside
 * `setOrderPaymentMessage` and does not consult the session at all. A leaked
 * (b) can only let a poller or the settled-bubble sweeper overwrite a menu
 * screen the buyer navigated to. Annoying, re-renderable on the next tap,
 * and never a wrong payment address.
 */
import { prisma, setOrderPaymentMessage, clearPaymentMessageAnchorsAt } from "@app/db";
import { logger } from "@app/core/logger";
import type { MyContext } from "../context";

/**
 * Point an order's payment-message anchor at this chat's menu bubble and
 * remember, in the session, that the bubble is now anchored.
 *
 * A no-op when the chat has no menu bubble yet: there is no message to anchor,
 * and writing a pointer to a message id we don't have would be a lie. Callers
 * therefore no longer need their own `if (ctx.session.menuMsgId)` guard.
 */
export async function anchorPaymentMessage(
  ctx: MyContext,
  orderId: number,
  chatId: number | bigint,
): Promise<void> {
  const messageId = ctx.session.menuMsgId;
  if (messageId === undefined) return;
  await setOrderPaymentMessage(prisma, orderId, chatId, messageId);
  ctx.session.paymentAnchorMsgId = messageId;
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
