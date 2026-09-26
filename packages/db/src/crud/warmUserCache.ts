/**
 * Small in-memory "warm" snapshot of recently-synced Telegram users.
 *
 * `registeredUser` (apps/order-bot/src/middleware.ts) upsert-writes to the DB
 * on every single Telegram update before anything else runs. Most of those
 * writes are redundant — the user's username/full name rarely changes
 * between messages. This cache lets that middleware skip the DB round trip
 * when nothing relevant has changed, while every mutator that actually
 * changes a user's role/ban/language/wallet (below) invalidates the entry so
 * the next update re-syncs from the DB instead of serving stale data.
 *
 * Lives in packages/db (not apps/order-bot) because both @app/order-bot and
 * apps/web-admin call the mutators that must invalidate it, and web-admin
 * does not depend on @app/order-bot.
 */
import { parseDisplayCurrency, type DisplayCurrency } from "@app/core/enums";

export interface WarmUserSnap {
  id: number;
  telegramId: string;
  username: string | null;
  fullName: string | null;
  /** Raw DB string values (role/language are plain `String` columns, not
   * native Prisma enums — mirrors `DbUserSnap` in apps/order-bot/src/context.ts). */
  role: string;
  language: string;
  referralCode: string;
  walletBalance: string;
  banned: boolean;
  bannedReason: string | null;
  /** Display-currency preference; null = not chosen yet (or an unrecognised
   * stored value, which is treated the same way rather than trusted). */
  preferredCurrency: DisplayCurrency | null;
  syncedAt: number;
}

/** The User columns a warm snapshot is built from (structural, so this module
 * stays free of a Prisma import; a full `User` row satisfies it). */
export interface WarmUserSource {
  id: number;
  username: string | null;
  fullName: string | null;
  role: string;
  language: string;
  referralCode: string;
  walletBalance: { toString(): string };
  banned: boolean;
  bannedReason: string | null;
  preferredCurrency: string | null;
}

/** Build the snapshot body `primeWarmUser` takes from a freshly read User row
 * — the single place snapshot fields are mapped, so a new column cannot be
 * silently dropped by one builder and not another. */
export function toWarmUserSnap(user: WarmUserSource): Omit<WarmUserSnap, "telegramId" | "syncedAt"> {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    role: user.role,
    language: user.language,
    referralCode: user.referralCode,
    walletBalance: String(user.walletBalance),
    banned: user.banned,
    bannedReason: user.bannedReason,
    preferredCurrency: parseDisplayCurrency(user.preferredCurrency),
  };
}

const TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, WarmUserSnap>();

/** Returns the cached snapshot if present and not expired, else undefined. */
export function peekWarmUser(telegramId: string): WarmUserSnap | undefined {
  const snap = cache.get(telegramId);
  if (!snap) return undefined;
  if (Date.now() - snap.syncedAt > TTL_MS) {
    cache.delete(telegramId);
    return undefined;
  }
  return snap;
}

export function primeWarmUser(telegramId: string, snap: Omit<WarmUserSnap, "telegramId" | "syncedAt">): void {
  cache.set(telegramId, { ...snap, telegramId, syncedAt: Date.now() });
}

/** Evict a user's warm snapshot by DB id (cache is keyed by telegramId — this
 * is a linear scan, but only called on the rare admin/self-service mutation
 * path, never the hot per-update path). */
export function invalidateWarmUser(userId: number): void {
  for (const [telegramId, snap] of cache) {
    if (snap.id === userId) {
      cache.delete(telegramId);
      return;
    }
  }
}
