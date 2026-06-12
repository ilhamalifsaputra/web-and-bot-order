/**
 * Message-rendering helpers — port of bot/utils/chat.py.
 *
 * Render rule: a button tap (callbackQuery) edits the bubble that owns the
 * button; typed input (command/text/photo) sends a NEW message. On edit
 * failure (e.g. editing a photo+caption bubble, or "message is not modified")
 * we fall through to a fresh send so the user always gets a response.
 */
import type { InlineKeyboard, Keyboard } from "grammy";
import { GrammyError } from "grammy";
import type { MyContext } from "../context";

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

/** Render the next customer screen (edit on tap, send on typed input). */
export async function smartEdit(ctx: MyContext, text: string, replyMarkup?: Markup): Promise<void> {
  // Clear qty-input mode on any navigation so it doesn't leak.
  ctx.session.awaitingQtyProductId = undefined;
  const body = truncateText(text);

  // Reply keyboards can't attach to an edit — only edit when the markup is
  // inline (or absent); otherwise fall through to a fresh send carrying it.
  if (ctx.callbackQuery && (replyMarkup === undefined || isInline(replyMarkup))) {
    const cqMsg = ctx.callbackQuery.message;
    try {
      // A photo+caption bubble (e.g. the QR payment screen) can't take an
      // editMessageText — edit its caption in place, like adminEdit does.
      if (cqMsg && "photo" in cqMsg && cqMsg.photo) {
        await ctx.editMessageCaption({ caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
      } else {
        await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: replyMarkup });
      }
      if (cqMsg) ctx.session.menuMsgId = cqMsg.message_id;
      return;
    } catch (err) {
      if (isNotModified(err)) return;
      // fall through to a fresh send
    }
  }
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  ctx.session.menuMsgId = msg.message_id;
}

// Telegram caption limit. A banner-as-photo render carries the menu text as the
// photo caption, so anything longer than this can't ride along — we fall back to
// a plain text render (no banner) for that screen.
const MAX_CAPTION_LEN = 1024;

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
  photoFileId?: string,
): Promise<void> {
  ctx.session.awaitingQtyProductId = undefined;
  const body = truncateText(text);

  if (photoFileId && body.length <= MAX_CAPTION_LEN) {
    // Editing in place only works when we're on a callback and the current
    // bubble is already a photo (the menus here use reply keyboards, so this is
    // rare — the common path is a fresh photo send below).
    if (ctx.callbackQuery && (replyMarkup === undefined || isInline(replyMarkup))) {
      const cqMsg = ctx.callbackQuery.message;
      if (cqMsg && "photo" in cqMsg && cqMsg.photo) {
        try {
          await ctx.editMessageCaption({ caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
          ctx.session.menuMsgId = cqMsg.message_id;
          return;
        } catch (err) {
          if (isNotModified(err)) return;
          // fall through to a fresh photo send
        }
      }
    }
    const msg = await ctx.replyWithPhoto(photoFileId, { caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
    ctx.session.menuMsgId = msg.message_id;
    return;
  }

  await smartEdit(ctx, text, replyMarkup);
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
      if (cqMsg) ctx.session.adminMsgId = cqMsg.message_id;
      return;
    } catch (err) {
      if (isNotModified(err)) return;
      // fall through
    }
  }
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  ctx.session.adminMsgId = msg.message_id;
}
