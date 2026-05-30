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
    try {
      await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: replyMarkup });
      if (ctx.callbackQuery.message) ctx.session.menuMsgId = ctx.callbackQuery.message.message_id;
      return;
    } catch (err) {
      if (isNotModified(err)) return;
      // fall through to a fresh send
    }
  }
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  ctx.session.menuMsgId = msg.message_id;
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
