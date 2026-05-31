/**
 * Users domain — port of the "Users" section of Python crud.py.
 * No function commits; the caller controls the transaction.
 */
import { config, isAdmin } from "@app/core/config";
import { UserRole, Language } from "@app/core/enums";
import { quantizeMoney, generateReferralCode } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";

const likeContains = (q: string) => ({ contains: q });

export function getUserByTelegramId(db: Db, telegramId: number | bigint) {
  return db.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
}

export function getUser(db: Db, userId: number) {
  return db.user.findUnique({ where: { id: userId } });
}

/**
 * Idempotent user creation. Refreshes username/full_name/last_seen on every
 * call; promotes to ADMIN on first sight if the telegram_id is allow-listed.
 */
export async function upsertUser(
  db: Db,
  args: {
    telegramId: number | bigint;
    username: string | null;
    fullName: string | null;
    referredByCode?: string | null;
  },
) {
  const telegramId = BigInt(args.telegramId);
  const existing = await db.user.findUnique({ where: { telegramId } });
  const now = new Date();

  if (existing) {
    const data: Record<string, unknown> = {
      username: args.username,
      fullName: args.fullName,
      lastSeenAt: now,
    };
    if (isAdmin(telegramId) && existing.role !== UserRole.ADMIN) {
      data.role = UserRole.ADMIN;
    }
    return db.user.update({ where: { id: existing.id }, data });
  }

  // Resolve referrer (by code), excluding self-referral.
  let referredById: number | null = null;
  if (args.referredByCode) {
    const referrer = await db.user.findUnique({
      where: { referralCode: args.referredByCode.toUpperCase() },
    });
    if (referrer && referrer.telegramId !== telegramId) {
      referredById = referrer.id;
    }
  }

  const role = isAdmin(telegramId) ? UserRole.ADMIN : UserRole.CUSTOMER;
  const language = config.DEFAULT_LANGUAGE.toUpperCase() as Language;

  // Retry on the (extremely unlikely) referral code collision.
  for (let i = 0; i < 5; i++) {
    try {
      const user = await db.user.create({
        data: {
          telegramId,
          username: args.username,
          fullName: args.fullName,
          role,
          language,
          referralCode: generateReferralCode(),
          referredById,
          createdAt: now,
          lastSeenAt: now,
        },
      });
      logger.info(`Registered new user telegram_id=${telegramId}`);
      return user;
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new Error("Could not generate a unique referral code");
}

export async function setUserLanguage(db: Db, userId: number, lang: string) {
  await db.user.update({
    where: { id: userId },
    data: { language: lang.toUpperCase() as Language },
  });
}

export interface WalletAdjustOpts {
  allowNegative?: boolean;
  /** Machine reason code for the ledger (e.g. admin_adjust, referral, refund). */
  reason?: string;
  note?: string | null;
  adminId?: number | null;
  orderId?: number | null;
}

/**
 * Atomically add `delta` (may be negative) to a wallet. Throws on overdraw
 * unless allowNegative. Returns the new balance. Run inside a $transaction
 * when paired with other money/stock mutations (SQLite serializes writers,
 * giving the same guarantee as the Python with_for_update lock).
 *
 * Every applied move also writes a `wallet_transactions` ledger row (running
 * balance + reason + optional admin/order), so the per-user money timeline is
 * complete — nothing that touches a balance is missed.
 */
export async function adjustWallet(
  db: Db,
  userId: number,
  delta: Decimal.Value,
  opts: WalletAdjustOpts = {},
): Promise<Decimal> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const oldBalance = new Decimal(user.walletBalance);
  const newBalance = quantizeMoney(oldBalance.plus(delta), 4);
  if (newBalance.lessThan(0) && !opts.allowNegative) {
    throw new ValidationError("error.insufficient_wallet");
  }
  await db.user.update({
    where: { id: userId },
    data: { walletBalance: newBalance },
  });
  await db.walletTransaction.create({
    data: {
      userId,
      delta: newBalance.minus(oldBalance), // the amount actually applied
      balanceAfter: newBalance,
      reason: opts.reason ?? "adjust",
      note: opts.note ?? null,
      adminId: opts.adminId ?? null,
      orderId: opts.orderId ?? null,
    },
  });
  return newBalance;
}

export async function setUserRole(db: Db, userId: number, role: UserRole) {
  await db.user.update({ where: { id: userId }, data: { role } });
}

export async function setUserBanned(
  db: Db,
  userId: number,
  banned: boolean,
  reason: string | null = null,
) {
  await db.user.update({
    where: { id: userId },
    data: { banned, bannedReason: reason },
  });
}

/** Search by telegram_id (if numeric), username, or full_name (contains). */
export function searchUsers(db: Db, query: string, limit = 20) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  const or: Record<string, unknown>[] = [
    { username: likeContains(q) },
    { fullName: likeContains(q) },
  ];
  if (/^\d+$/.test(q)) or.push({ telegramId: BigInt(q) });
  return db.user.findMany({ where: { OR: or }, take: limit });
}

/** Sum of total_amount for this user's DELIVERED orders. */
export async function userTotalSpent(db: Db, userId: number): Promise<Decimal> {
  const agg = await db.order.aggregate({
    where: { userId, status: "DELIVERED" },
    _sum: { totalAmount: true },
  });
  return new Decimal(agg._sum.totalAmount ?? 0);
}

export interface WalletLedgerEntry {
  createdAt: Date;
  delta: string;
  balanceAfter: string;
  reason: string;
  note: string;
  adminId: number | null;
  orderId: number | null;
}

/**
 * Complete per-user wallet timeline from the `wallet_transactions` ledger —
 * every applied move (manual top-up, refund, referral payout, order
 * payment/refund) with its running balance, newest first.
 */
export async function listWalletLedger(
  db: Db,
  userId: number,
  limit = 50,
): Promise<WalletLedgerEntry[]> {
  const rows = await db.walletTransaction.findMany({
    where: { userId },
    orderBy: { id: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    createdAt: r.createdAt,
    delta: new Decimal(r.delta).toString(),
    balanceAfter: new Decimal(r.balanceAfter).toString(),
    reason: r.reason,
    note: r.note ?? "",
    adminId: r.adminId,
    orderId: r.orderId,
  }));
}
