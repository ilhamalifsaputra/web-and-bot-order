/**
 * Users domain — port of the "Users" section of Python crud.py.
 * No function commits; the caller controls the transaction.
 */
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import { UserRole, Language, OrderStatus } from "@app/core/enums";
import { quantizeMoney, generateReferralCode } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { startOfDayUtc } from "@app/core/datetime";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { invalidateWarmUser } from "./warmUserCache";

const likeContains = (q: string) => ({ contains: q });

/** Admins are managed on the separate Admins page — the Customers page's list,
 * filters, and KPIs never include role=ADMIN, filtered or not. */
const NON_ADMIN_ROLES = [UserRole.CUSTOMER, UserRole.RESELLER];

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
      logger.info(`Registered new user with Telegram id ${telegramId}`);
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
  invalidateWarmUser(userId);
}

export interface WalletAdjustOpts {
  allowNegative?: boolean;
  /** Machine reason code for the ledger (e.g. admin_adjust, referral, refund). */
  reason?: string;
  note?: string | null;
  adminId?: number | null;
  orderId?: number | null;
  /**
   * Which credit balance this move applies to. "IDR" → `walletBalance`,
   * "USDT" → `walletBalanceUsdt`. Defaults to "IDR" so every existing caller
   * keeps behaving exactly as before. No cross-currency conversion.
   */
  currency?: "IDR" | "USDT";
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
  const currency = opts.currency ?? "IDR";
  const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
  const oldBalance = new Decimal(currency === "USDT" ? user.walletBalanceUsdt : user.walletBalance);
  const newBalance = quantizeMoney(oldBalance.plus(delta), 4);
  if (newBalance.lessThan(0) && !opts.allowNegative) {
    throw new ValidationError("error.insufficient_wallet");
  }
  await db.user.update({
    where: { id: userId },
    data: currency === "USDT" ? { walletBalanceUsdt: newBalance } : { walletBalance: newBalance },
  });
  await db.walletTransaction.create({
    data: {
      userId,
      delta: newBalance.minus(oldBalance), // the amount actually applied
      balanceAfter: newBalance,
      currency,
      reason: opts.reason ?? "adjust",
      note: opts.note ?? null,
      adminId: opts.adminId ?? null,
      orderId: opts.orderId ?? null,
    },
  });
  invalidateWarmUser(userId);
  return newBalance;
}

export async function setUserRole(db: Db, userId: number, role: UserRole) {
  await db.user.update({ where: { id: userId }, data: { role } });
  invalidateWarmUser(userId);
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
  invalidateWarmUser(userId);
}

/** Search by telegram_id (if numeric), username, or full_name (contains). */
export function searchUsers(db: Db, query: string, limit = 20) {
  const q = query.trim();
  if (!q) return Promise.resolve([]);
  const or: Record<string, unknown>[] = [
    { username: likeContains(q) },
    { fullName: likeContains(q) },
    { loginUsername: likeContains(q) },
    { email: likeContains(q) },
  ];
  if (/^\d+$/.test(q)) or.push({ telegramId: BigInt(q) });
  return db.user.findMany({ where: { OR: or }, take: limit });
}

/** Most recently registered users — the Customers page's default browse list. */
export function listRecentUsers(db: Db, limit = 20) {
  return db.user.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

/** This user's DELIVERED-order totals, split per transaction currency (orders
 * predating the currency column count as USDT — their snapshot unit). */
export async function userTotalSpent(
  db: Db,
  userId: number,
): Promise<{ idr: Decimal; usdt: Decimal }> {
  const groups = await db.order.groupBy({
    by: ["currency"],
    where: { userId, status: "DELIVERED" },
    _sum: { totalAmount: true },
  });
  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  for (const g of groups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum);
    else usdt = usdt.plus(sum);
  }
  return { idr, usdt };
}

/** Batched DELIVERED-order totals for a page of users, split per transaction
 * currency (orders predating the currency column count as USDT — their
 * snapshot unit). One `groupBy` for the whole page instead of one query per
 * row (the N+1 pattern `userTotalSpent` has when called per-row). Users with
 * no DELIVERED orders are absent from the returned Map — callers should
 * default to `{ idr: new Decimal(0), usdt: new Decimal(0) }` on a miss. */
export async function totalSpentByUserIds(
  db: Db,
  userIds: number[],
): Promise<Map<number, { idr: Decimal; usdt: Decimal }>> {
  const result = new Map<number, { idr: Decimal; usdt: Decimal }>();
  if (userIds.length === 0) return result;
  const groups = await db.order.groupBy({
    by: ["userId", "currency"],
    where: { userId: { in: userIds }, status: "DELIVERED" },
    _sum: { totalAmount: true },
  });
  for (const g of groups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    const entry = result.get(g.userId) ?? { idr: new Decimal(0), usdt: new Decimal(0) };
    if (g.currency === "IDR") entry.idr = entry.idr.plus(sum);
    else entry.usdt = entry.usdt.plus(sum);
    result.set(g.userId, entry);
  }
  return result;
}

export interface WalletLedgerEntry {
  createdAt: Date;
  delta: string;
  balanceAfter: string;
  /** Currency this row's delta/balanceAfter are denominated in ("IDR" | "USDT"). */
  currency: string;
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
    currency: r.currency,
    reason: r.reason,
    note: r.note ?? "",
    adminId: r.adminId,
    orderId: r.orderId,
  }));
}

// ---- Filtered list/count/KPIs for the Customers admin page ----------------

export type UserSort = "newest" | "oldest" | "lastSeen" | "spend";

export interface UserFilter {
  role?: Exclude<UserRole, "ADMIN"> | null; // CUSTOMER or RESELLER only; null/omitted = both (never ADMIN)
  banned?: boolean | null; // true=banned only, false=active only, null/omitted=both
  q?: string | null; // same OR-contains shape as searchUsers
  since?: Date | null; // createdAt >=
  until?: Date | null; // createdAt <=
  lastSeenSince?: Date | null; // lastSeenAt >=
  lastSeenUntil?: Date | null; // lastSeenAt <=
  ids?: number[] | null; // restrict to this exact id set (bulk export-selected)
}

function userWhere(f: UserFilter): Prisma.UserWhereInput {
  // Runtime guard: ensure ADMIN is never included, even if someone casts around
  // the type. Only permit f.role if it's actually in NON_ADMIN_ROLES.
  const allowedRoles = f.role && NON_ADMIN_ROLES.includes(f.role) ? [f.role] : NON_ADMIN_ROLES;
  const where: Prisma.UserWhereInput = {
    role: { in: allowedRoles },
  };
  if (f.banned != null) where.banned = f.banned;
  if (f.ids != null) where.id = { in: f.ids };
  if (f.since != null || f.until != null) {
    where.createdAt = {};
    if (f.since != null) where.createdAt.gte = f.since;
    if (f.until != null) where.createdAt.lte = f.until;
  }
  if (f.lastSeenSince != null || f.lastSeenUntil != null) {
    where.lastSeenAt = {};
    if (f.lastSeenSince != null) where.lastSeenAt.gte = f.lastSeenSince;
    if (f.lastSeenUntil != null) where.lastSeenAt.lte = f.lastSeenUntil;
  }
  if (f.q) {
    const term = f.q.trim();
    const or: Prisma.UserWhereInput[] = [
      { username: likeContains(term) },
      { fullName: likeContains(term) },
      { loginUsername: likeContains(term) },
      { email: likeContains(term) },
    ];
    if (/^\d+$/.test(term)) or.push({ telegramId: BigInt(term) });
    where.OR = or;
  }
  return where;
}

function userOrderBy(sort?: UserSort): Prisma.UserOrderByWithRelationInput {
  if (sort === "oldest") return { createdAt: "asc" };
  if (sort === "lastSeen") return { lastSeenAt: "desc" };
  return { createdAt: "desc" };
}

/**
 * Rank a filtered set of user ids by DELIVERED-order IDR spend, descending,
 * then return the requested page of ids. A single `findMany` relation-orderBy
 * cannot sort by a child relation's `_sum`, only `_count` — this two-phase
 * approach (match ids, then `groupBy`-rank them) is required because `groupBy`
 * DOES support ordering by `_sum`.
 *
 * IDR-only, deliberately — spend is inherently two numbers (IDR, USDT) and
 * blending them into one ranking would fabricate a single scalar
 * (`CurrencyStack` exists specifically to avoid exactly that). Users with no
 * DELIVERED IDR orders (including USDT-only spenders) rank as zero-IDR-
 * spenders, appended after every real IDR spender in their original
 * createdAt-desc order.
 */
async function rankUserIdsBySpend(
  db: Db,
  where: Prisma.UserWhereInput,
  offset: number,
  limit: number,
): Promise<number[]> {
  const matched = await db.user.findMany({ where, select: { id: true }, orderBy: { createdAt: "desc" } });
  const matchedIds = matched.map((u) => u.id);
  if (matchedIds.length === 0) return [];

  const ranked = await db.order.groupBy({
    by: ["userId"],
    where: { userId: { in: matchedIds }, status: OrderStatus.DELIVERED, currency: "IDR" },
    _sum: { totalAmount: true },
    orderBy: { _sum: { totalAmount: "desc" } },
  });
  const rankedIds = ranked.map((r) => r.userId);
  const rankedSet = new Set(rankedIds);
  const zeroSpendIds = matchedIds.filter((id) => !rankedSet.has(id)); // already createdAt-desc
  const fullyRankedIds = [...rankedIds, ...zeroSpendIds];
  return fullyRankedIds.slice(offset, offset + limit);
}

/** Filtered, sorted, paginated user list — the Customers page's data source. */
export async function listUsers(
  db: Db,
  opts: UserFilter & { sort?: UserSort; limit?: number; offset?: number } = {},
) {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const where = userWhere(opts);

  if (opts.sort === "spend") {
    const pageIds = await rankUserIdsBySpend(db, where, offset, limit);
    if (pageIds.length === 0) return [];
    const rows = await db.user.findMany({ where: { id: { in: pageIds } } });
    const byId = new Map(rows.map((u) => [u.id, u]));
    return pageIds.map((id) => byId.get(id)).filter((u): u is (typeof rows)[number] => u != null);
  }

  return db.user.findMany({ where, orderBy: userOrderBy(opts.sort), skip: offset, take: limit });
}

/** Count matching `listUsers`' filter — for the Customers page's pagination total. */
export function countUsers(db: Db, opts: UserFilter = {}) {
  return db.user.count({ where: userWhere(opts) });
}

export interface CustomersKpis {
  totalCustomers: number;
  newToday: number;
  activeToday: number;
  returningCustomers: number;
  totalRevenue: { idr: Decimal; usdt: Decimal };
}

/**
 * Customers page KPI row. All figures are non-admin only.
 * `returningCustomers` counts users with >=2 DELIVERED orders — a user with 1
 * DELIVERED + 3 PENDING does not count. `totalRevenue` is all-time (distinct
 * from Orders' "Revenue Today"), DELIVERED-only.
 */
export async function customersKpis(db: Db): Promise<CustomersKpis> {
  const todayStart = startOfDayUtc();
  const nonAdmin = { role: { in: NON_ADMIN_ROLES } };
  const [totalCustomers, newToday, activeToday, returningGroups, revenueGroups] = await Promise.all([
    db.user.count({ where: nonAdmin }),
    db.user.count({ where: { ...nonAdmin, createdAt: { gte: todayStart } } }),
    db.user.count({ where: { ...nonAdmin, lastSeenAt: { gte: todayStart } } }),
    db.order.groupBy({ by: ["userId"], where: { status: OrderStatus.DELIVERED, user: nonAdmin }, _count: { _all: true } }),
    db.order.groupBy({ by: ["currency"], where: { status: OrderStatus.DELIVERED, user: nonAdmin }, _sum: { totalAmount: true } }),
  ]);

  const returningCustomers = returningGroups.filter((g) => g._count._all >= 2).length;

  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  for (const g of revenueGroups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum); else usdt = usdt.plus(sum);
  }
  return { totalCustomers, newToday, activeToday, returningCustomers, totalRevenue: { idr, usdt } };
}

export interface UserOrderStats {
  totalOrders: number; // any status
  lastOrderAt: Date | null; // max createdAt, any status
  deliveredOrders: number; // DELIVERED only — feeds the per-row "Returning" badge in Task 5
}

/**
 * Batched per-user order stats for a page of users — exactly 3 `groupBy`
 * calls total for the whole page (never one query per user), mirroring
 * `totalSpentByUserIds`'s existing batching discipline. Users with zero
 * orders are absent from the returned Map.
 */
export async function orderStatsByUserIds(db: Db, userIds: number[]): Promise<Map<number, UserOrderStats>> {
  const result = new Map<number, UserOrderStats>();
  if (userIds.length === 0) return result;

  const [counts, lastOrders, delivered] = await Promise.all([
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _count: { _all: true } }),
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _max: { createdAt: true } }),
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds }, status: OrderStatus.DELIVERED }, _count: { _all: true } }),
  ]);
  const lastMap = new Map(lastOrders.map((r) => [r.userId, r._max.createdAt]));
  const deliveredMap = new Map(delivered.map((r) => [r.userId, r._count._all]));
  for (const c of counts) {
    result.set(c.userId, {
      totalOrders: c._count._all,
      lastOrderAt: lastMap.get(c.userId) ?? null,
      deliveredOrders: deliveredMap.get(c.userId) ?? 0,
    });
  }
  return result;
}

/** In-memory throttle for touchLastSeen — same TTL/pattern as
 * warmUserCache.ts's cache, so a busy storefront session doesn't take a
 * lastSeenAt write on every single page view (SQLite is single-writer). */
const LAST_SEEN_TOUCH_TTL_MS = 5 * 60 * 1000;
const lastSeenTouchedAt = new Map<number, number>();

/**
 * Refresh a user's lastSeenAt from web activity, throttled to at most once
 * per LAST_SEEN_TOUCH_TTL_MS per user. The bot already keeps lastSeenAt
 * fresh on every message via upsertUser; the storefront never touched it at
 * all before this, so web-only customers looked permanently inactive after
 * registration. Called from the storefront's per-request customer
 * resolution — fire-and-forget, not awaited by the caller.
 */
export async function touchLastSeen(db: Db, userId: number): Promise<void> {
  const lastTouch = lastSeenTouchedAt.get(userId);
  const now = Date.now();
  if (lastTouch != null && now - lastTouch < LAST_SEEN_TOUCH_TTL_MS) return;
  lastSeenTouchedAt.set(userId, now);
  await db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } });
}
