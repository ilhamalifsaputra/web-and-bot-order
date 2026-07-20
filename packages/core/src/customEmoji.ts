/**
 * Telegram custom emoji (premium animated icons) in outgoing HTML messages.
 *
 * Telegram renders a custom emoji from an entity, which in HTML parse mode is
 * `<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>` — the emoji inside
 * the tag is the fallback shown to clients that can't render the sticker.
 * Rather than rewriting the hundreds of emoji already sitting in
 * `locales/{en,id}.json`, the shop admin configures ONE map of
 * `unicode emoji → custom_emoji_id` (the `custom_emoji_map` Setting) and the
 * send layer upgrades every mapped emoji on its way out. Empty map = every
 * message renders exactly as it did before the feature existed.
 *
 * Eligibility is Telegram's, not ours: a bot may only send custom emoji
 * entities if it owns a Fragment-purchased username, or — for messages it
 * sends directly to private/group/supergroup chats — if the bot owner has
 * Telegram Premium. Channel posts are NOT covered by the Premium path, so the
 * send layer must be able to fall back (see {@link stripCustomEmoji}).
 *
 * Module-level state stamped at boot and on a Settings save, mirroring
 * `runtime.ts` — synchronous consumers (an API transformer) can't await a DB read.
 */
import { logger } from "./logger";

/** Setting key holding the JSON map (web-admin editable). */
export const CUSTOM_EMOJI_MAP_SETTING = "custom_emoji_map";

let emojiToId = new Map<string, string>();

/** Entries sorted longest-first so a ZWJ sequence wins over its first char. */
function rebuild(entries: [string, string][]): void {
  emojiToId = new Map(entries.sort((a, b) => b[0].length - a[0].length));
}

/**
 * Stamp the configured map from its stored JSON (`{"✅": "5368324...", …}`).
 * Blank/absent value clears it. Malformed JSON, or entries that aren't
 * emoji→numeric-id strings, are dropped rather than thrown: a typo in Settings
 * must never take the bot's sending path down.
 */
export function setCustomEmojiMap(json: string | null | undefined): void {
  if (!json || !json.trim()) {
    emojiToId = new Map();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    logger.warn(
      "The custom emoji map setting is not valid JSON, so custom emoji are disabled and messages will render with plain unicode emoji until it is corrected in Settings.",
    );
    emojiToId = new Map();
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    logger.warn(
      "The custom emoji map setting is not a JSON object of emoji to id, so custom emoji are disabled and messages will render with plain unicode emoji.",
    );
    emojiToId = new Map();
    return;
  }
  const entries: [string, string][] = [];
  let skipped = 0;
  for (const [emoji, id] of Object.entries(parsed as Record<string, unknown>)) {
    if (emoji && typeof id === "string" && /^\d+$/.test(id)) entries.push([emoji, id]);
    else skipped++;
  }
  if (skipped > 0) {
    logger.warn(
      { skipped },
      "Some entries of the custom emoji map were ignored because their value was not a numeric custom emoji id; those emoji keep rendering as plain unicode.",
    );
  }
  rebuild(entries);
}

/** Test hook: forget the stamped map so renders fall back to plain emoji. */
export function resetCustomEmojiMap(): void {
  emojiToId = new Map();
}

/** True when at least one emoji is mapped (send layer can skip the work). */
export function hasCustomEmoji(): boolean {
  return emojiToId.size > 0;
}

// Splits an HTML string into chunks that must be left alone — a whole <pre> or
// <code> block, or any single tag — and the plain text between them. Code
// blocks are excluded because Telegram won't nest a custom emoji entity inside
// one, and because their content is meant to be copied verbatim (order codes,
// credentials, the /emojiid JSON).
const SKIP_SPLIT = /(<pre[\s\S]*?<\/pre>|<code[^>]*>[\s\S]*?<\/code>|<[^>]*>)/;

/**
 * Wrap every mapped emoji of an already-HTML-safe string in a `<tg-emoji>` tag.
 * Idempotent: text that already carries a `<tg-emoji>` is returned untouched,
 * and tag internals are never rewritten.
 */
export function applyCustomEmoji(html: string): string {
  if (emojiToId.size === 0 || !html || html.includes("<tg-emoji")) return html;
  return html
    .split(SKIP_SPLIT)
    .map((chunk) => {
      if (chunk.startsWith("<")) return chunk; // a tag or a code block — leave it alone
      let out = chunk;
      for (const [emoji, id] of emojiToId) {
        if (!out.includes(emoji)) continue;
        out = out.split(emoji).join(`<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`);
      }
      return out;
    })
    .join("");
}

const TG_EMOJI_TAG = /<tg-emoji emoji-id="\d+">([\s\S]*?)<\/tg-emoji>/g;

/**
 * Inverse of {@link applyCustomEmoji}: unwrap the tags, keeping the fallback
 * emoji. Used to retry a send that Telegram rejected for the entity (e.g. a
 * channel post, which the Premium-owner allowance doesn't cover) so the message
 * still lands, just with plain emoji.
 */
export function stripCustomEmoji(html: string): string {
  if (!html || !html.includes("<tg-emoji")) return html;
  return html.replace(TG_EMOJI_TAG, "$1");
}
