/**
 * Process-wide resolved bot identity (plan.md §16).
 *
 * The bot token / username / notifier token now primarily live in the
 * `Setting` table (web-admin editable, "DB wins when filled, env is the
 * bootstrap/recovery fallback"). The composition root resolves them ONCE at
 * boot — grammY can't hot-swap a token on a running Bot, so a token edit
 * always requires a controlled restart (§16.2) — and stashes them here so
 * synchronous consumers (handlers building referral links, the Telegram Login
 * HMAC check, the admin file-download URL) don't each need a DB read.
 *
 * Before boot stamps anything (unit tests, standalone dev entries) every
 * getter falls back to the env config, which preserves the historical
 * behaviour exactly.
 */
import { config } from "./config";

interface BotIdentity {
  botToken?: string;
  botUsername?: string;
  notifBotToken?: string;
}

let resolved: BotIdentity = {};

/** Stamp the boot-resolved credentials (composition root / service start). */
export function setBotIdentity(identity: BotIdentity): void {
  resolved = { ...resolved, ...identity };
}

/** Test hook: forget boot-resolved values so getters fall back to env again. */
export function resetBotIdentity(): void {
  resolved = {};
}

/** Main bot token — DB-resolved value if stamped, else BOT_TOKEN env. */
export function botToken(): string | undefined {
  return resolved.botToken ?? config.BOT_TOKEN;
}

/** Bot username (no @) — DB/getMe-resolved if stamped, else BOT_USERNAME env. */
export function botUsername(): string | undefined {
  return resolved.botUsername ?? config.BOT_USERNAME;
}

/** Dedicated notifier token — DB-resolved if stamped, else NOTIF_BOT_TOKEN env. */
export function notifBotToken(): string | undefined {
  return resolved.notifBotToken ?? config.NOTIF_BOT_TOKEN;
}
