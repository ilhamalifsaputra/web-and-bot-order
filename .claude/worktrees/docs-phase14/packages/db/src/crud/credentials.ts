/**
 * Boot-time bot credential resolution (plan.md §16).
 *
 * Priority is fixed and documented: the Settings row wins when filled,
 * otherwise the env var — so web-admin is the source of truth and env stays
 * the bootstrap / "un-brick the bot" recovery path (§16.4 #4). Empty/blank
 * Settings values count as unset.
 */
import { config } from "@app/core/config";
import type { Db } from "./_types";
import { getSetting } from "./settings";

export const BOT_TOKEN_KEY = "bot_token";
export const BOT_USERNAME_KEY = "bot_username";
export const NOTIF_BOT_TOKEN_KEY = "notif_bot_token";
export const PUBLIC_CHANNEL_ID_KEY = "public_channel_id";

const orNull = (v: string | null | undefined): string | null =>
  v && v.trim() !== "" ? v.trim() : null;

/** Parse a stored channel id to a finite number; null when blank/non-numeric. */
const parseChannelId = (v: string | null | undefined): number | null => {
  const s = orNull(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

export interface ResolvedBotCredentials {
  /** Main bot token, or null when neither Setting nor env is set (bot stays off). */
  botToken: string | null;
  /** Bot username (no @) — may still be null until getMe fills it at boot. */
  botUsername: string | null;
  /** Dedicated notifier token; null = reuse the main bot. */
  notifBotToken: string | null;
  /** Public channel id for announcements; null = notifier disabled. */
  publicChannelId: number | null;
}

/** Resolve all four credentials: Setting wins when filled, else env. */
export async function resolveBotCredentials(db: Db): Promise<ResolvedBotCredentials> {
  const [token, username, notifToken, channelId] = await Promise.all([
    getSetting(db, BOT_TOKEN_KEY),
    getSetting(db, BOT_USERNAME_KEY),
    getSetting(db, NOTIF_BOT_TOKEN_KEY),
    getSetting(db, PUBLIC_CHANNEL_ID_KEY),
  ]);
  return {
    botToken: orNull(token) ?? orNull(config.BOT_TOKEN),
    botUsername: orNull(username) ?? orNull(config.BOT_USERNAME),
    notifBotToken: orNull(notifToken) ?? orNull(config.NOTIF_BOT_TOKEN),
    publicChannelId: parseChannelId(channelId) ?? (config.PUBLIC_CHANNEL_ID ?? null),
  };
}
