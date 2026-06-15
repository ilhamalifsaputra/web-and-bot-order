/**
 * Message-rendering helpers — port of bot/utils/chat.py.
 *
 * Render rule: a button tap (callbackQuery) edits the bubble that owns the
 * button; typed input (command/text/photo) sends a NEW message. On edit
 * failure (e.g. editing a photo+caption bubble, or "message is not modified")
 * we fall through to a fresh send so the user always gets a response.
 */
import { InputFile, type InlineKeyboard, type Keyboard } from "grammy";
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

/**
 * Best-effort: strip the inline keyboard off an older bubble so only the
 * freshly rendered screen keeps live buttons. Keeps the "one active screen per
 * chat" invariant — without this, every fresh send leaves the previous menu's
 * buttons tappable, and a tap there acts on moved-on state.
 */
export async function retireKeyboard(ctx: MyContext, messageId: number): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
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
      if (cqMsg) {
        // The tap may have landed on an older bubble — retire the previously
        // active menu so two screens never stay live at once.
        const prev = ctx.session.menuMsgId;
        if (prev !== undefined && prev !== cqMsg.message_id) await retireKeyboard(ctx, prev);
        ctx.session.menuMsgId = cqMsg.message_id;
      }
      return;
    } catch (err) {
      if (isNotModified(err)) return;
      // fall through to a fresh send
    }
  }
  const prev = ctx.session.menuMsgId ?? ctx.callbackQuery?.message?.message_id;
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  if (prev !== undefined && prev !== msg.message_id) await retireKeyboard(ctx, prev);
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
  photo?: string | InputFile,
  onPhotoSent?: (fileId: string) => void | Promise<void>,
): Promise<void> {
  ctx.session.awaitingQtyProductId = undefined;
  const body = truncateText(text);

  if (photo && body.length <= MAX_CAPTION_LEN) {
    // Editing in place only works when we're on a callback and the current
    // bubble is already a photo (the menus here use reply keyboards, so this is
    // rare — the common path is a fresh photo send below).
    if (ctx.callbackQuery && (replyMarkup === undefined || isInline(replyMarkup))) {
      const cqMsg = ctx.callbackQuery.message;
      if (cqMsg && "photo" in cqMsg && cqMsg.photo) {
        try {
          await ctx.editMessageCaption({ caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
          const prev = ctx.session.menuMsgId;
          if (prev !== undefined && prev !== cqMsg.message_id) await retireKeyboard(ctx, prev);
          ctx.session.menuMsgId = cqMsg.message_id;
          return;
        } catch (err) {
          if (isNotModified(err)) return;
          // fall through to a fresh photo send
        }
      }
    }
    const prev = ctx.session.menuMsgId ?? ctx.callbackQuery?.message?.message_id;
    const msg = await ctx.replyWithPhoto(photo, { caption: body, parse_mode: "HTML", reply_markup: replyMarkup });
    if (prev !== undefined && prev !== msg.message_id) await retireKeyboard(ctx, prev);
    ctx.session.menuMsgId = msg.message_id;
    if (onPhotoSent && msg.photo?.length) await onPhotoSent(msg.photo[msg.photo.length - 1]!.file_id);
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
): Promise<number | undefined> {
  const body = truncateText(text);
  const chatId = ctx.chat?.id;
  if (chatId !== undefined && anchorId !== undefined && (replyMarkup === undefined || isInline(replyMarkup))) {
    try {
      await ctx.api.editMessageText(chatId, anchorId, body, { parse_mode: "HTML", reply_markup: replyMarkup });
      return anchorId;
    } catch (err) {
      if (isNotModified(err)) return anchorId;
      // fall through to a fresh send (anchor may be a photo or deleted)
    }
  }
  const msg = await ctx.reply(body, { parse_mode: "HTML", reply_markup: replyMarkup });
  if (anchorId !== undefined && anchorId !== msg.message_id) await retireKeyboard(ctx, anchorId);
  return msg.message_id;
}

/** Render a customer wizard step into the anchor bubble (edit-in-place). */
export async function menuAnchor(ctx: MyContext, text: string, replyMarkup?: Markup): Promise<void> {
  if (ctx.callbackQuery) return smartEdit(ctx, text, replyMarkup);
  ctx.session.awaitingQtyProductId = undefined;
  ctx.session.menuMsgId = await editAnchor(ctx, ctx.session.menuMsgId, text, replyMarkup);
}

/** Render an admin wizard step into the anchor bubble (edit-in-place). */
export async function adminAnchor(ctx: MyContext, text: string, replyMarkup?: Markup): Promise<void> {
  if (ctx.callbackQuery) return adminEdit(ctx, text, replyMarkup);
  ctx.session.adminMsgId = await editAnchor(ctx, ctx.session.adminMsgId, text, replyMarkup);
}
