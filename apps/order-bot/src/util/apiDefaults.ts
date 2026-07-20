/**
 * Outgoing-call defaults shared by every bot instance in the process (the main
 * order bot and, when a separate token is configured, the notifier bot that
 * drains the outbox). Installed as a grammY API transformer so handlers never
 * have to repeat `parse_mode`, and so custom emoji are applied in ONE place
 * instead of at ~200 call sites.
 */
import { GrammyError, type Transformer } from "grammy";
import { logger } from "@app/core/logger";
import { applyCustomEmoji, hasCustomEmoji, stripCustomEmoji } from "@app/core/customEmoji";

// Which payload field carries the HTML body, and which field would carry
// pre-parsed entities (in which case parse_mode is ignored and we must not touch
// the text at all).
const HTML_FIELD: Record<string, { text: "text" | "caption"; entities: string }> = {
  sendMessage: { text: "text", entities: "entities" },
  editMessageText: { text: "text", entities: "entities" },
  sendPhoto: { text: "caption", entities: "caption_entities" },
  editMessageCaption: { text: "caption", entities: "caption_entities" },
};

/**
 * Telegram refuses custom emoji entities unless the bot bought a username on
 * Fragment, or (private/group/supergroup chats only) the bot owner has Premium
 * — so a channel post, or a stale emoji id, comes back as a 400. Recognise
 * those so the send can be retried with plain emoji instead of being lost.
 */
function isCustomEmojiRejection(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    /custom[_ ]?emoji|can't parse entities|unsupported start tag/i.test(err.description)
  );
}

/** Apply/strip custom emoji on whichever body field this method carries. */
function rewriteBody(
  method: string,
  payload: Record<string, unknown>,
  transform: (html: string) => string,
): Record<string, unknown> | undefined {
  const field = HTML_FIELD[method];
  if (!field) return undefined;
  if (payload.parse_mode !== "HTML" || field.entities in payload) return undefined;
  const body = payload[field.text];
  if (typeof body !== "string") return undefined;
  const next = transform(body);
  return next === body ? undefined : { ...payload, [field.text]: next };
}

/**
 * HTML by default, link previews off, and custom emoji upgraded on the way out.
 * `parse_mode` is only added when the caller supplied neither a parse mode nor
 * pre-built entities, so callers that build entities themselves are untouched.
 */
export function htmlDefaultsTransformer(): Transformer {
  return async (prev, method, payload, signal) => {
    const p = payload as Record<string, unknown>;
    if (method === "sendMessage" || method === "editMessageText") {
      if (p && !("parse_mode" in p) && !("entities" in p)) p.parse_mode = "HTML";
      if (p && !("link_preview_options" in p)) p.link_preview_options = { is_disabled: true };
    } else if (method === "sendPhoto" || method === "editMessageCaption") {
      if (p && !("parse_mode" in p) && !("caption_entities" in p)) p.parse_mode = "HTML";
    }

    if (!hasCustomEmoji()) return prev(method, payload as never, signal);

    const upgraded = p ? rewriteBody(method, p, applyCustomEmoji) : undefined;
    if (!upgraded) return prev(method, payload as never, signal);

    try {
      return await prev(method, upgraded as never, signal);
    } catch (err) {
      if (!isCustomEmojiRejection(err)) throw err;
      // Send it anyway, with plain unicode emoji: this chat isn't allowed
      // custom emoji (a channel post is the usual case — the bot owner's
      // Premium allowance only covers private/group chats) or an id in the
      // custom emoji map is no longer valid.
      logger.warn(
        { err, method },
        "Telegram rejected the custom emoji in an outgoing message, so it was resent with plain unicode emoji instead. " +
          "The message was delivered, but the configured custom emoji map does not apply to this chat — likely a channel post, " +
          "or an id in Settings → custom emoji map is invalid.",
      );
      const plain = rewriteBody(method, upgraded, stripCustomEmoji) ?? payload;
      return prev(method, plain as never, signal);
    }
  };
}
