/**
 * Process-wide resolved identity (plan.md §16 + setup-wizard spec §5/§6).
 *
 * Bot token/username/notifier token, the admin allow-list, and the web cookie
 * secret primarily live in the `Setting` table (web-admin editable / wizard).
 * The composition root resolves them ONCE at boot and stamps them here so
 * synchronous consumers don't each need a DB read. Before boot stamps anything
 * (unit tests, standalone dev) getters fall back to env config.
 */
import { config } from "./config";

interface Resolved {
  botToken?: string;
  botUsername?: string;
  notifBotToken?: string;
  publicChannelId?: number;
  adminIds?: number[];
  webCookieSecret?: string;
}

let resolved: Resolved = {};

/** Stamp boot-resolved bot credentials (composition root / service start). */
export function setBotIdentity(identity: {
  botToken?: string;
  botUsername?: string;
  notifBotToken?: string;
  publicChannelId?: number;
}): void {
  resolved = { ...resolved, ...identity };
}

/** Test hook: forget all stamped values so getters fall back to env again. */
export function resetBotIdentity(): void {
  resolved = {};
}

export function botToken(): string | undefined {
  return resolved.botToken ?? config.BOT_TOKEN;
}

export function botUsername(): string | undefined {
  return resolved.botUsername ?? config.BOT_USERNAME;
}

export function notifBotToken(): string | undefined {
  return resolved.notifBotToken ?? config.NOTIF_BOT_TOKEN;
}

export function publicChannelId(): number | undefined {
  return resolved.publicChannelId ?? config.PUBLIC_CHANNEL_ID;
}

// ---- Admin allow-list (env ∪ DB) -----------------------------------------

/** Stamp the boot-resolved admin id set (union of env + DB Setting). */
export function setAdminIds(ids: number[]): void {
  resolved.adminIds = Array.from(new Set(ids.map(Number)));
}

/** Add one admin id live (single process — wizard / /admins). Idempotent. */
export function addAdminId(id: number): void {
  const next = new Set((resolved.adminIds ?? config.ADMIN_IDS).map(Number));
  next.add(Number(id));
  resolved.adminIds = Array.from(next);
}

/** Resolved admin ids if stamped, else env config (historical behaviour). */
export function adminIds(): number[] {
  return resolved.adminIds ?? config.ADMIN_IDS;
}

/** True if the Telegram id is an admin (env ∪ DB). */
export function isAdmin(telegramId: number | bigint): boolean {
  return adminIds().includes(Number(telegramId));
}

// ---- Web cookie secret ----------------------------------------------------

/** Stamp the boot-resolved web cookie secret (env, else DB, else generated). */
export function setWebSecret(secret: string): void {
  resolved.webCookieSecret = secret;
}

/** Resolved secret if stamped, else env config (may be undefined pre-boot). */
export function webCookieSecret(): string | undefined {
  return resolved.webCookieSecret ?? config.WEB_COOKIE_SECRET;
}
