/**
 * Message-rendering helpers — port of bot/utils/chat.py.
 *
 * Render rule: a button tap (callbackQuery) edits the bubble that owns the
 * button; typed input (command/text/photo) sends a NEW message. On edit
 * failure (e.g. editing a photo+caption bubble, or "message is not modified")
 * we fall through to a fresh send so the user always gets a response.
 * Exceptions: wizard anchors (menuAnchor/adminAnchor) and a typed "← Back"
 * (editMenuOnTypedNavigation) edit the session-tracked bubble instead.
 */
import { InputFile, type InlineKeyboard, type Keyboard } from "grammy";
import { GrammyError } from "grammy";
import type { MyContext } from "../context";
import { releasePaymentAnchorIfReused } from "./paymentAnchor";
import { prisma } from "@app/db";

// Inline keyboards can ride on a message edit; reply keyboards (Keyboard /
// ReplyKeyboardRemove) cannot, so smartEdit routes those through a fresh send.
type Markup = InlineKeyboard | Keyboard | { remove_keyboard: true } | undefined;

function isInline(m: Markup): m is InlineKeyboard {
  return m != null && "inline_keyboard" in m;
}

const MAX_MSG_LEN = 4096;
const TRUNCATION_SUFFIX = "\n\n<i>… (truncated)</i>";

export function truncateText(text: string, limit = MAX_MSG_LEN): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

function isNotModified(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    /message is not modified/i.test(err.description)
  );
}

/** Telegram's answer to editMessageText on a photo+caption bubble. */
function isPhotoBubble(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    /there is no text in the message to edit/i.test(err.description)
  );
}

async function isTransactionBubble(ctx: MyContext, messageId: number | undefined): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (messageId === undefined || chatId === undefined) return false;
  return !!(await prisma.fulfillmentMessage.findFirst({ where: { chatId: BigInt(chatId), messageId }, select: { orderId: true } }));
}

/**
 * Best-effort: strip the inline keyboard off an older bubble so only the
 * freshly rendered screen keeps live buttons. Keeps the "one active screen per
 * chat" invariant — without this, every fresh send leaves the previous menu's
 * buttons tappable, and a tap there acts on moved-on state.
 */
export async function retireKeyboard(ctx: MyContext, messageId: number): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  if (await isTransactionBubble(ctx, messageId)) return;
  try {
    await ctx.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: undefined });
  } catch {
    /* old, deleted, or never had a keyboard — nothing to clean */
  }
}

/**
 * Best-effort delete of the user's typed wizard input. Used by multi-step
 * flows so the chat stays a single anchor bubble instead of accumulating
 * prompt → input → error → input chains — and so sensitive pastes (stock
 * credentials) don't linger in the visible history. Bots may delete incoming
 * messages in private chats for 48h; failures are ignored.
 */
export async function consumeInput(ctx: MyContext): Promise<void> {
  const m = ctx.message;
  const chatId = ctx.chat?.id;
  if (!m || chatId === undefined) return;
  try {
    await ctx.api.deleteMessage(chatId, m.message_id);
  } catch {
    /* too old or not deletable — leave it */
  }
}

/**
 * Options for a render that may land on a photo bubble. `captionText` is the
 * caption-sized form of the screen (fitted to MAX_CAPTION_LEN by the caller,
 * which knows what may give way); it is used whenever the bubble actually
 * being edited turns out to be a photo, so the decision follows that bubble's
 * type rather than a guess made before the edit.
 */
export interface RenderOptions {
  captionText?: string;
  /**
   * Anti-stacking for the catalog screens of an inline service (Game Top-up
   * and every service that is not numbered): when this screen cannot be drawn
   * into the bubble the buyer tapped (a text bubble becoming a photo, a photo
   * becoming a text-only screen, an edit that failed), that tapped bubble is
   * obsolete. It is DELETED once its one replacement has been sent, instead of
   * only losing its keyboard — so repeated forward/Back cycles never pile up
   * dead bubbles (1 send + 1 delete per transition). Never a transaction
   * bubble (an order's payment/status message, the session's payment anchor);
   * a failed delete falls back to retiring the keyboard and never blocks.
   * Premium Apps (numbered) never passes it, so its output is unchanged.
   */
  replaceTapped?: boolean;
  /**
   * The screen is a plain-text message (the Game Top-up pack picker): a tapped
   * photo bubble is replaced by one text message (deleted as above), never
   * captioned; a typed navigation drops a photo anchor the same way.
   */
  textOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Per-update render modes (never persisted: they describe THIS update only)
// ---------------------------------------------------------------------------

/** Updates whose tapped bubble was deleted during this update (a product photo
 * dropped on Back): no render may try to edit or retire it any more. */
const tappedBubbleGone = new WeakSet<MyContext>();
/** Typed navigation (a typed "← Back") that renders into the bot-owned menu
 * bubble (menuMsgId) like a wizard anchor, instead of sending a new bubble.
 * `textOnly` — the target is a plain-text screen, so a photo anchor (a product
 * photo) is deleted and replaced rather than captioned with it. */
const typedNavigation = new WeakMap<MyContext, { textOnly: boolean }>();

/** Record that this update deleted the tapped bubble (see tappedBubbleGone). */
export function markTappedBubbleDeleted(ctx: MyContext): void {
  tappedBubbleGone.add(ctx);
}

/** True once markTappedBubbleDeleted ran for this update. */
export function tappedBubbleDeleted(ctx: MyContext): boolean {
  return tappedBubbleGone.has(ctx);
}

/** This (typed) update navigates by editing the menu bubble; see typedNavigation. */
export function editMenuOnTypedNavigation(ctx: MyContext): void {
  typedNavigation.set(ctx, { textOnly: false });
}

/** True while a typed navigation renders into the menu bubble. */
export function isTypedNavigation(ctx: MyContext): boolean {
  return typedNavigation.has(ctx);
}

/** One line shown above the screen a typed navigation renders (this update only). */
const typedNavigationNotice = new WeakMap<MyContext, string>();

/** The typed navigation's screen carries `notice` above its own text — e.g.
 * "tap a button" when a digit was typed on an inline-only screen, which then
 * re-renders that same screen (buttons kept) in the menu bubble. */
export function noticeOnTypedNavigation(ctx: MyContext, notice: string): void {
  typedNavigationNotice.set(ctx, notice);
}

function withTypedNavigationNotice(ctx: MyContext, text: string): string {
  const notice = typedNavigationNotice.get(ctx);
  return notice ? `${notice}\n\n${text}` : text;
}

/** The typed navigation lands on a plain-text screen: a photo anchor is replaced, not captioned. */
export function preferTextAnchor(ctx: MyContext): void {
  const mode = typedNavigation.get(ctx);
  if (mode) mode.textOnly = true;
}

/** Input modes and the "a catalog screen is showing" mark end with every render;
 * a catalog screen marks itself again right after its own render. */
function endScreenModes(ctx: MyContext): void {
  // Clear qty-input / wallet-topup-amount-input mode on any navigation so
  // neither leaks into a later typed message on an unrelated screen.
  ctx.session.awaitingQtyDenomId = undefined;
  ctx.session.awaitingTopupCurrency = undefined;
  delete ctx.session.scratch.searchAwaiting;
  delete ctx.session.scratch.catalogScreen;
}

/** True when the tapped bubble of this callback update is a photo+caption bubble. */
function tappedIsPhoto(ctx: MyContext): boolean {
  const cqMsg = ctx.callbackQuery?.message;
  return !!cqMsg && "photo" in cqMsg && !!cqMsg.photo;
}

/**
 * Callbacks a catalog screen's keyboard may carry: the browse / search screens
 * themselves, the pack detail's quantity stepper, Buy (it only opens the
 * order confirmation; no order exists yet) and restock buttons, the page
 * indicator / disabled stepper no-op, and the main-menu button of a Back row.
 * Anything else (order:, pay*, usdt:, voucher:, checkout:, wallet*, topup:,
 * ticket:, help:, a URL or copy button…) marks a bubble that is NOT a catalog
 * screen — a receipt, a payment or confirmation screen — and such a bubble is
 * never deleted.
 */
const CATALOG_CALLBACK = /^v1:(?:(?:browse|search|qty|buy|restock):.+|noop|menu:main)$/;
const SCREEN_CALLBACK = /^v1:(?:browse|search):/;

/**
 * ALLOWLIST for deleting an obsolete bubble: true only when every button of
 * `markup` is a catalog callback (CATALOG_CALLBACK) and at least one opens a
 * browse / search screen. A missing or empty keyboard is never a catalog one.
 */
export function isCatalogKeyboard(markup: unknown): boolean {
  const rows = (markup as { inline_keyboard?: unknown } | null | undefined)?.inline_keyboard;
  if (!Array.isArray(rows)) return false;
  const buttons = rows.flat() as Array<{ callback_data?: unknown } | null | undefined>;
  let opensScreen = false;
  for (const button of buttons) {
    const data = button?.callback_data;
    if (typeof data !== "string" || !CATALOG_CALLBACK.test(data)) return false;
    if (SCREEN_CALLBACK.test(data)) opensScreen = true;
  }
  return opensScreen;
}

/** Track the menu bubble and whether it now shows a catalog-only keyboard. */
function setMenuBubble(ctx: MyContext, messageId: number | undefined, markup: Markup): void {
  ctx.session.menuMsgId = messageId;
  ctx.session.catalogMsgId = messageId !== undefined && isCatalogKeyboard(markup) ? messageId : undefined;
}

/** Best-effort delete of an obsolete bubble that is not a transaction bubble or the payment anchor; true when it is gone. */
async function deleteObsoleteBubble(ctx: MyContext, messageId: number): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || ctx.session.paymentAnchorMsgId === messageId || (await isTransactionBubble(ctx, messageId))) return false;
  try {
    await ctx.api.deleteMessage(chatId, messageId);
    return true;
  } catch {
    return false; // too old (48 h), not ours, or already gone
  }
}

/**
 * After a fresh send (`newId`) replaced the screen of a catalog render
 * (`replaceTapped`, or `textOnly` replacing a tapped photo): the tapped bubble
 * is obsolete and is deleted when its own keyboard is a catalog one
 * (isCatalogKeyboard — an allowlist: a receipt's "Buy again", a payment or a
 * confirmation bubble is never deleted, only its keyboard retired). A previous
 * menu bubble `prev` that is not the tapped one (a fast double tap whose first
 * update already deleted the tapped bubble) is deleted too when it was
 * rendered as a catalog bubble (session.catalogMsgId), so the live message
 * count stays constant. A failed delete retires the keyboard and never blocks.
 * Without those options the keyboard of `prev` is retired, exactly as before.
 */
async function retireReplacedBubble(ctx: MyContext, prev: number | undefined, newId: number, opts?: RenderOptions): Promise<void> {
  const catalogRender = !!opts?.replaceTapped || (!!opts?.textOnly && tappedIsPhoto(ctx));
  if (!catalogRender) {
    if (prev !== undefined && prev !== newId) await retireKeyboard(ctx, prev);
    return;
  }
  const tapped = tappedBubbleGone.has(ctx) ? undefined : ctx.callbackQuery?.message;
  const tappedId = tapped?.message_id;
  if (tappedId !== undefined && tappedId !== newId) {
    if (isCatalogKeyboard(tapped?.reply_markup) && (await deleteObsoleteBubble(ctx, tappedId))) markTappedBubbleDeleted(ctx);
    // Not a catalog bubble (a receipt's "Buy again"…) or not deletable: it stays, without its keyboard.
    else if (prev !== tappedId) await retireKeyboard(ctx, tappedId);
  }
  if (prev === undefined || prev === newId) return;
  if (prev === tappedId && tappedBubbleGone.has(ctx)) return;
  if (prev !== tappedId && ctx.session.catalogMsgId === prev && (await deleteObsoleteBubble(ctx, prev))) return;
  await retireKeyboard(ctx, prev);
}

/** Render the next customer screen (edit on tap, send on typed input). */
export async function smartEdit(ctx: MyContext, text: string, replyMarkup?: Markup, opts?: RenderOptions): Promise<void> {
  endScreenModes(ctx);
  const body = truncateText(text);

  // A typed "← Back" edits the bot-owned menu bubble in place (an inline
  // screen only; a reply keyboard still needs a fresh send).
  const typedNav = typedNavigation.get(ctx);
  if (!ctx.callbackQuery && typedNav && (replyMarkup === undefined || isInline(replyMarkup))) {
    setMenuBubble(ctx, await editAnchor(ctx, ctx.session.menuMsgId, withTypedNavigationNotice(ctx, text), replyMarkup, {
      replacePhoto: typedNav.textOnly || !!opts?.textOnly,
      captionText: opts?.captionText !== undefined ? withTypedNavigationNotice(ctx, opts.captionText) : undefined,
    }), replyMarkup);
    return;
  }

  // Reply keyboards can't attach to an edit — only edit when the markup is
  // inline (or absent); otherwise fall through to a fresh send carrying it.
  const tappedGone = tappedBubbleGone.has(ctx);
  const tappedId = tappedGone ? undefined : ctx.callbackQuery?.message?.message_id;
  // Transaction status bubbles remain owned by their coordinator. Navigating
  // opens the menu separately so another order cannot inherit this message.
  const transactionBubble = await isTransactionBubble(ctx, tappedId);
  // A text-only screen never becomes a photo's caption: straight to the one
  // fresh text send below, which then deletes the obsolete photo.
  const photoReplaced = !!opts?.textOnly && tappedIsPhoto(ctx);
  // A tapped bubble deleted earlier in this update is not edited (the call
  // could only fail): straight to the fresh send below.
  if (ctx.callbackQuery && !tappedGone && !transactionBubble && !photoReplaced && (replyMarkup === undefined || isInline(replyMarkup))) {
    const cqMsg = ctx.callbackQuery.message;
    let edited = true;
    try {
      // A photo+caption bubble (e.g. the QR payment screen) can't take an
      // editMessageText — edit its caption in place, like adminEdit does.
      if (cqMsg && "photo" in cqMsg && cqMsg.photo) {
        const caption = opts?.captionText !== undefined ? truncateText(opts.captionText) : body;
        await ctx.editMessageCaption({ caption, parse_mode: "HTML", reply_markup: replyMarkup });
      } else {
        await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: replyMarkup });
      }
    } catch (err) {
      if (!isNotModified(err)) edited = false; // genuine failure — fall through to a fresh send
    }
    if (edited) {
      if (cqMsg) {
        // The tap may have landed on an older bubble — retire the previously
        // active menu so two screens never stay live at once. This also runs
        // when the edit no-op'd ("message is not modified" — the bubble
        // already showed this exact content): that's still a successful
        // render, so the tapped message must still become the anchor. A past
        // bug returned early on that no-op without ever reaching this
        // assignment, which left ctx.session.menuMsgId stale/unset whenever a
        // re-render happened to match the bubble's existing content exactly
        // — permanently breaking any later poller's "edit this order's
        // anchored bubble" lookup for that chat.
        const prev = ctx.session.menuMsgId;
        if (prev !== undefined && prev !== cqMsg.message_id) await retireKeyboard(ctx, prev);
        setMenuBubble(ctx, cqMsg.message_id, replyMarkup);
        // This bubble may have been an order's payment screen a moment ago; it
        // now shows a menu, so that order's claim on it has to go. Session-gated
        // and free when nothing is anchored — see util/paymentAnchor.ts.
        await releasePaymentAnchorIfReused(ctx, cqMsg.message_id);
      }
      return;
    }
  }
  const prev = ctx.session.menuMsgId ?? tappedId;
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  await retireReplacedBubble(ctx, prev, msg.message_id, opts);
  setMenuBubble(ctx, msg.message_id, replyMarkup);
}

// Telegram caption limit. A banner-as-photo render carries the menu text as the
// photo caption, so anything longer than this can't ride along — we fall back to
// a plain text render (no banner) for that screen.
export const MAX_CAPTION_LEN = 1024;

/**
 * Render a menu screen, optionally with a banner image on top. When `photoFileId`
 * is set and the text fits in a caption, the screen becomes a single photo+caption
 * bubble (image + menu text), so the banner reads as part of the chat. Otherwise
 * (no banner, or text too long for a caption) it falls back to {@link smartEdit}.
 *
 * Only the main-menu and product-list renderers pass a banner — payment screens
 * never do, so the banner is absent there by construction.
 */
export async function renderMenu(
  ctx: MyContext,
  text: string,
  replyMarkup?: Markup,
  photo?: string | InputFile,
  onPhotoSent?: (fileId: string) => void | Promise<void>,
  /** `replaceTapped` only (see RenderOptions): a tapped text bubble replaced by this photo is deleted. */
  opts?: Pick<RenderOptions, "replaceTapped">,
): Promise<void> {
  endScreenModes(ctx);
  const body = truncateText(text);
  const inlineOrNone = replyMarkup === undefined || isInline(replyMarkup);

  // A typed "← Back" renders into the menu bubble (smartEdit): its caption when
  // that bubble is a photo, else its text — never a new photo bubble.
  if (photo && body.length <= MAX_CAPTION_LEN && !(typedNavigation.has(ctx) && !ctx.callbackQuery && inlineOrNone)) {
    // Editing in place only works when we're on a callback and the current
    // bubble is already a photo (the menus here use reply keyboards, so this is
    // rare — the common path is a fresh photo send below). A tapped bubble
    // deleted earlier in this update is never edited.
    const tappedGone = tappedBubbleGone.has(ctx);
    if (ctx.callbackQuery && !tappedGone && !(await isTransactionBubble(ctx, ctx.callbackQuery.message?.message_id)) && inlineOrNone) {
      const cqMsg = ctx.callbackQuery.message;
      if (cqMsg && "photo" in cqMsg && cqMsg.photo) {
        let edited = true;
        try {
          await ctx.editMessageCaption({ caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
        } catch (err) {
          if (!isNotModified(err)) edited = false; // genuine failure — fall through to a fresh photo send
        }
        if (edited) {
          // Same "no-op edit is still a successful render" fix as smartEdit
          // above — see its comment for why returning early without this
          // assignment was a bug.
          const prev = ctx.session.menuMsgId;
          if (prev !== undefined && prev !== cqMsg.message_id) await retireKeyboard(ctx, prev);
          setMenuBubble(ctx, cqMsg.message_id, replyMarkup);
          // A caption edit leaves the message alive showing this menu, so an
          // anchored payment screen here is now gone — release it (same gate as
          // smartEdit). The QRIS/PayDisini wait screen IS a photo+caption
          // bubble, so this path is reachable with a live anchor.
          await releasePaymentAnchorIfReused(ctx, cqMsg.message_id);
          return;
        }
      }
    }
    const prev = ctx.session.menuMsgId ?? (tappedGone ? undefined : ctx.callbackQuery?.message?.message_id);
    const msg = await ctx.replyWithPhoto(photo, { caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
    await retireReplacedBubble(ctx, prev, msg.message_id, opts);
    setMenuBubble(ctx, msg.message_id, replyMarkup);
    if (onPhotoSent && msg.photo?.length) await onPhotoSent(msg.photo[msg.photo.length - 1]!.file_id);
    return;
  }

  await smartEdit(ctx, text, replyMarkup, opts);
}

/** Render the next admin screen. Photo+caption bubbles edit the caption. */
export async function adminEdit(ctx: MyContext, text: string, replyMarkup?: Markup): Promise<void> {
  const body = truncateText(text);

  if (ctx.callbackQuery && (replyMarkup === undefined || isInline(replyMarkup))) {
    const cqMsg = ctx.callbackQuery.message;
    try {
      if (cqMsg && "photo" in cqMsg && cqMsg.photo) {
        await ctx.editMessageCaption({ caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
      } else {
        await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: replyMarkup });
      }
      if (cqMsg) {
        const prev = ctx.session.adminMsgId;
        if (prev !== undefined && prev !== cqMsg.message_id) await retireKeyboard(ctx, prev);
        ctx.session.adminMsgId = cqMsg.message_id;
      }
      return;
    } catch (err) {
      if (isNotModified(err)) return;
      // fall through
    }
  }
  const prev = ctx.session.adminMsgId ?? ctx.callbackQuery?.message?.message_id;
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  if (prev !== undefined && prev !== msg.message_id) await retireKeyboard(ctx, prev);
  ctx.session.adminMsgId = msg.message_id;
}

// ---------------------------------------------------------------------------
// Wizard anchors — multi-step flows keep ONE bubble that every prompt, error
// and confirmation edits in place. Typed input would normally fall through to
// a fresh send (smartEdit/adminEdit only edit on a tap); these helpers instead
// edit the session-tracked anchor message, so a wizard never accumulates
// prompt → input → error chains. Pair with consumeInput() on the typed update.
// ---------------------------------------------------------------------------

async function editAnchor(
  ctx: MyContext,
  anchorId: number | undefined,
  text: string,
  replyMarkup?: Markup,
  /** `replacePhoto`: see the photo branch below; `captionText`: see RenderOptions. */
  opts: RenderOptions & { replacePhoto?: boolean } = {},
): Promise<number | undefined> {
  const body = truncateText(text);
  const captionBody = opts.captionText !== undefined ? truncateText(opts.captionText) : body;
  const chatId = ctx.chat?.id;
  let anchorGone = false;
  if (chatId !== undefined && anchorId !== undefined && !(await isTransactionBubble(ctx, anchorId)) && (replyMarkup === undefined || isInline(replyMarkup))) {
    try {
      await ctx.api.editMessageText(chatId, anchorId, body, { parse_mode: "HTML", reply_markup: replyMarkup });
      return anchorId;
    } catch (err) {
      if (isNotModified(err)) return anchorId;
      if (isPhotoBubble(err)) {
        // The anchor is a photo+caption bubble (a wizard started from a
        // product-detail photo): its caption is the editable part. Without
        // this, every typed step fell through to a fresh send — one new
        // bubble per step instead of one wizard bubble.
        // `replacePhoto`: a plain-text screen (typed Back from a product
        // photo) — the photo is obsolete, drop it like an over-long caption.
        if (captionBody.length <= MAX_CAPTION_LEN && !opts.replacePhoto) {
          try {
            await ctx.api.editMessageCaption(chatId, anchorId, { caption: captionBody, parse_mode: "HTML", reply_markup: replyMarkup });
            return anchorId;
          } catch (captionErr) {
            if (isNotModified(captionErr)) return anchorId;
            // fall through to a fresh send
          }
        } else {
          // Too long for a caption: drop the photo and send ONE text bubble
          // that becomes the anchor, rather than leaving a photo with a
          // stale prompt above the new screen. Best effort — a failed delete
          // just leaves the photo, whose keyboard is retired below.
          try {
            await ctx.api.deleteMessage(chatId, anchorId);
            anchorGone = true;
          } catch {
            /* too old or already gone */
          }
        }
      }
      // fall through to a fresh send (anchor deleted, or not editable)
    }
  }
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  if (!anchorGone && anchorId !== undefined && anchorId !== msg.message_id) await retireKeyboard(ctx, anchorId);
  return msg.message_id;
}

/** Render a customer wizard step into the anchor bubble (edit-in-place). */
export async function menuAnchor(ctx: MyContext, text: string, replyMarkup?: Markup, opts?: RenderOptions): Promise<void> {
  if (ctx.callbackQuery) return smartEdit(ctx, text, replyMarkup, opts);
  endScreenModes(ctx);
  setMenuBubble(ctx, await editAnchor(ctx, ctx.session.menuMsgId, withTypedNavigationNotice(ctx, text), replyMarkup, {
    replacePhoto: typedNavigation.get(ctx)?.textOnly,
    captionText: opts?.captionText !== undefined ? withTypedNavigationNotice(ctx, opts.captionText) : undefined,
  }), replyMarkup);
}

/** Render an admin wizard step into the anchor bubble (edit-in-place). */
export async function adminAnchor(ctx: MyContext, text: string, replyMarkup?: Markup): Promise<void> {
  if (ctx.callbackQuery) return adminEdit(ctx, text, replyMarkup);
  ctx.session.adminMsgId = await editAnchor(ctx, ctx.session.adminMsgId, text, replyMarkup);
}
