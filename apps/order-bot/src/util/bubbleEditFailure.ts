/**
 * One question, asked from five places: when an anchored payment-bubble edit
 * fails, may the order's anchor (`paymentMsgChatId`/`paymentMsgId`) be cleared?
 *
 * The anchor IS the work queue. `sweepPaidOrderBubbles` (jobs/index.ts) lists
 * exactly the settled orders that still carry one, so clearing an anchor is
 * irreversible in practice: nothing will ever look at that bubble again. That
 * makes the two failure classes pull in opposite directions.
 *
 *  - PERMANENT — the message is gone, can no longer be edited, or already
 *    shows what we wanted to put there. Retrying is doomed, and a doomed retry
 *    is not free: it burns one of the sweep's MAX_ORDERS_PER_CYCLE slots every
 *    single minute, forever, crowding out bubbles that could still be fixed.
 *    Clear the anchor and let the order self-heal out of the queue.
 *  - TRANSIENT — flood control, a 5xx, a network fault, an error we simply do
 *    not recognise. The very same edit can succeed a minute later. Clearing
 *    here permanently strands the buyer on a stale "waiting for payment" QR
 *    for an order that is already paid and delivered, with nothing left in the
 *    system that would ever retry it. Keep the anchor.
 *
 * The asymmetry is why anything unrecognised counts as transient: a wrongly
 * transient call costs one bounded API call per minute until the order's row
 * is eventually cleaned up, while a wrongly permanent call is a user-visible
 * defect nobody will notice until the buyer complains.
 *
 * Only a `GrammyError` is trusted, because only a `GrammyError` means Telegram
 * itself answered and said why. A `HttpError`, an `AbortError`, a Prisma
 * failure or a bare `Error` all mean the request may never have reached
 * Telegram at all, which is the textbook case for retrying.
 */
import { GrammyError } from "grammy";

/**
 * Telegram `description` fragments (matched case-insensitively, as substrings,
 * because Telegram appends explanatory tails to several of these) that mean
 * this bubble will never accept this edit:
 *
 *  - `message is not modified` — the bubble ALREADY shows the text and keyboard
 *    the edit wanted to put there. The goal is met, so this is a success
 *    wearing an error's clothes; retrying would fail identically forever.
 *  - `message to edit not found` / `message_id_invalid` — the buyer (or
 *    Telegram's 48-hour deletion of service messages) removed the bubble.
 *  - `message can't be edited` — Telegram refuses edits on this message for
 *    good, e.g. it is too old or was not sent by this bot.
 *  - `chat not found` — the chat the anchor points at is unreachable for good.
 *  - `bot was blocked by the user` / `user is deactivated` / `bot was kicked
 *    from` — the bot has lost the right to touch this chat. These can in
 *    principle reverse (a user may unblock), but they persist for hours or
 *    days rather than seconds, and an anchor kept through one of them means
 *    re-attempting the same rejected call every minute for the whole outage.
 *    Treated as permanent deliberately: the buyer who blocked the bot is not
 *    looking at the stale bubble anyway.
 *
 * Deliberately NOT here: `there is no text in the message to edit` and `there
 * is no caption in the message to edit`. Those say the WRONG edit method was
 * used for this bubble's shape, not that the bubble is dead — and
 * `editPaymentBubble` (jobs/index.ts) recovers from exactly that by trying the
 * other method. Calling them permanent would let a rail that only ever calls
 * `editMessageText` throw away an anchor the generic sweeper could still fix.
 */
const PERMANENT_EDIT_FAILURES = [
  "message is not modified",
  "message to edit not found",
  "message can't be edited",
  "message_id_invalid",
  "chat not found",
  "bot was blocked by the user",
  "user is deactivated",
  "bot was kicked from",
];

/**
 * True when `error` proves the anchored bubble can never accept this edit, so
 * the caller may clear the anchor and stop retrying. False for every failure
 * that might succeed on a later attempt — including every error that is not a
 * Telegram API error at all. See this module's doc comment for why the
 * unknown case lands on "retry".
 */
export function isPermanentBubbleEditFailure(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const description = error.description.toLowerCase();
  return PERMANENT_EDIT_FAILURES.some((fragment) => description.includes(fragment));
}
