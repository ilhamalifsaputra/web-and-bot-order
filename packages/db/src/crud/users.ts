/**
 * Users domain — port of the "Users" section of Python crud.py.
 * No function commits; the caller controls the transaction.
 */
import { config } from "@app/core/config";
import { isAdmin } from "@app/core/runtime";
import { UserRole, Language, OrderStatus, OrderKind } from "@app/core/enums";
import { quantizeMoney, generateReferralCode } from "@app/core/formatters";
import { Decimal } from "@app/core/money";
import { ValidationError } from "@app/core/errors";
import { logger } from "@app/core/logger";
import { startOfDayUtc } from "@app/core/datetime";
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { isUniqueViolation } from "./_types";
import { invalidateWarmUser } from "./warmUserCache";
import { walletSpendByCurrency, walletSpendByUser } from "./revenue";

// `mode: "insensitive"` is a Postgres-only Prisma feature (uses ILIKE under
// the hood); SQLite's `contains` was always case-insensitive by default so
// this had no explicit equivalent pre-migration.
const likeContains = (q: string) => ({ contains: q, mode: "insensitive" as const });

/** Admins are managed on the separate Admins page — the Customers page's list,
 * filters, and KPIs never include role=ADMIN, filtered or not. */
const NON_ADMIN_ROLES = [UserRole.CUSTOMER, UserRole.RESELLER];

/**
 * Every "what has this customer bought / how much have they spent" aggregate in
 * this file carries this clause (Financial Ledger M6, Task 6a).
 *
 * A settled `WALLET_TOPUP` is a real `Order` row at `DELIVERED` —
 * `settleWalletTopup` (crud/wallet_topup.ts) writes `PENDING_PAYMENT ->
 * DELIVERED` directly — so before this filter existed, a buyer moving their own
 * money into their own wallet counted as spend on their profile and as shop
 * revenue on the Customers page KPI row.
 *
 * Funding a wallet is not spending: the money is still the buyer's (it sits in
 * the `wallet_liability.<ccy>` control account, not a revenue account) and it is
 * counted for real when they later place a WALLET-paid product order. Counting
 * both double-counts the same rupiah, and a shop with top-up history will see
 * these figures DROP — that is the correction.
 *
 * NOT applied to the pure account-activity fields: `orderStatsByUserIds`'
 * `totalOrders`/`lastOrderAt` (the Customers page's "Orders"/"Last Order"
 * columns) still count every kind, because those columns answer "what has this
 * account been doing", not "what has it bought". See that function's comment.
 */
const SPEND_KIND_FILTER = { kind: OrderKind.PRODUCT } as const;

/** Every User column except `passwordHash` and `email` — the general-purpose
 * projection for `getUser`/`listUsers`, used by web-admin's Customers page and
 * order-bot's admin/customer/checkout handlers alike. These two functions'
 * results get spread straight into JSON responses readable by the
 * lowest-privilege `readonly` admin role (Customers list, detail, CSV
 * export), so `passwordHash` must NEVER be selectable here (backend audit
 * finding H-4). `email` is dropped too: nothing that reads through this
 * projection renders it (checked against UsersPage.tsx/UserDetailPage.tsx and
 * every order-bot caller) — the one caller that genuinely needs the full row
 * (email + passwordHash, for the storefront's own-account settings page) uses
 * `getUserWithPasswordHash` in crud/webauth.ts instead. Mirrors the
 * TICKET_USER_SELECT pattern in crud/support.ts. Add new User columns here
 * explicitly as they're added to the schema — this list is NOT auto-synced
 * with Prisma's model. */
const USER_SELECT = {
  id: true,
  telegramId: true,
  username: true,
  fullName: true,
  loginUsername: true,
  role: true,
  language: true,
  walletBalance: true,
  walletBalanceUsdt: true,
  referralCode: true,
  referredById: true,
  banned: true,
  bannedReason: true,
  createdAt: true,
  lastSeenAt: true,
} as const;

/** USER_SELECT plus `email` — the admin global-search projection
 * (`/api/search`). SearchModal.tsx's `userLabel()` uses `email` as an
 * identity fallback (fullName → username → loginUsername → email →
 * telegramId) for a storefront-only customer with no Telegram link and no
 * display name, so search can't drop it the way the general-purpose
 * USER_SELECT does. Still deliberately excludes `passwordHash` —
 * `searchUsers`'s results are spread straight into `/api/search`'s admin
 * JSON response, reachable by the lowest-privilege `readonly` role, same
 * threat `USER_SELECT` guards against (backend audit finding H-4). */
const SEARCH_USER_SELECT = {
  ...USER_SELECT,
  email: true,
} as const;

/** Never returns `passwordHash` or `email` (see USER_SELECT above). Verified
 * (backend audit follow-up, 2026-08-02) that every caller only reads
 * `id`/`role`/`banned`/`fullName`/`username`/`language`/`telegramId` off the
 * result — storefront's `establishSession` (routes/auth.ts) reads
 * `telegramId` to mint the customer session (`makeCustomerSession`).
 * Telegram-linked admin/bot accounts authenticate via a separate
 * settings-store hash (`passwordHashKey`, checked in web-admin's
 * `routes/auth.ts`), never `User.passwordHash`, so projecting this out does
 * not touch any login path. */
export function getUserByTelegramId(db: Db, telegramId: number | bigint) {
  return db.user.findUnique({ where: { telegramId: BigInt(telegramId) }, select: USER_SELECT });
}

/** General-purpose user lookup — never returns `passwordHash` or `email` (see
 * USER_SELECT above). Login/credential verification uses
 * `getUserWithPasswordHash` (crud/webauth.ts) instead. */
export function getUser(db: Db, userId: number) {
  return db.user.findUnique({ where: { id: userId }, select: USER_SELECT });
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

/** What one applied wallet movement tells its caller. */
export interface WalletAdjustResult {
  /** The balance after the movement, in the currency that was adjusted. */
  balance: Decimal;
  /**
   * The id of the `WalletTransaction` row this movement just wrote.
   *
   * Returned, rather than left to be looked up afterwards, because it is what
   * the ledger postings built on top of a wallet movement derive their
   * idempotency key from (`wallet:{transactionId}` — see
   * crud/ledgerPostings.ts). A caller could otherwise only re-find "the most
   * recent matching row", and that query races: this function holds a row lock
   * on the USER for the duration of the caller's transaction, so two
   * adjustments for the same user serialize, but a second one committing
   * between the first caller's `create` and its post-hoc `findFirst` would hand
   * back the wrong id — and a ledger posting keyed off the wrong row silently
   * suppresses a real posting (the key looks already-used) or attaches an
   * amount to the wrong movement. A returned id cannot be wrong.
   *
   * It also identifies the exact row whose `delta` and `currency` the posting
   * should read, which is what keeps the ledger amount equal to the amount the
   * wallet actually moved rather than to the amount the caller asked for.
   */
  transactionId: number;
}

/**
 * Atomically add `delta` (may be negative) to a wallet. Throws on overdraw
 * unless allowNegative. Returns the new balance and the id of the
 * `WalletTransaction` row written for the movement (see `WalletAdjustResult`).
 *
 * "Atomically" is enforced here, not inherited from the caller. The read of
 * the current balance, the overdraw check and the write-back are one
 * read-modify-write cycle, and under Postgres two callers for the same user
 * can genuinely run it at the same instant: both would read the same
 * pre-movement balance, both would pass their own overdraw check, and
 * whichever committed last would silently overwrite the other's movement — a
 * double-spend on debits, a lost credit on top-ups. (Under the old SQLite
 * deployment the single-writer connection pool serialized every writer in the
 * process, so the cycle was accidentally race-free and needed no lock. That
 * protection is gone.) So the cycle runs with the user row held under
 * `SELECT ... FOR UPDATE`, which makes concurrent callers for the same user
 * queue behind each other and each read the previous one's committed result.
 * See wallet_concurrency.test.ts.
 *
 * A row lock only lasts as long as the transaction holding it, so this needs
 * one to exist. Callers pass either the bare `prisma` client or a `tx` they
 * already opened (`Db` is `PrismaClient | Tx`), and a `Tx` cannot nest another
 * transaction — so open one when given the bare client, and reuse the caller's
 * when given a `tx` (the lock then lives until the caller commits, which is
 * exactly the scope they need for their own paired money/stock mutations).
 *
 * Every applied move also writes a `wallet_transactions` ledger row (running
 * balance + reason + optional admin/order), so the per-user money timeline is
 * complete — nothing that touches a balance is missed.
 *
 * That ledger row is written BEFORE the balance, and can be rejected: since
 * Task E5 the table is UNIQUE on (orderId, reason), so a second movement for
 * the same order and reason throws instead of doubling a buyer's money. See
 * the comment at the write itself for why the order of the two writes is what
 * makes that rejection safe. Callers that legitimately move a wallet more than
 * once for one order must pass a different `reason`; callers with no order
 * (`orderId` null) are unconstrained.
 */
export async function adjustWallet(
  db: Db,
  userId: number,
  delta: Decimal.Value,
  opts: WalletAdjustOpts = {},
): Promise<WalletAdjustResult> {
  const currency = opts.currency ?? "IDR";

  /** The read-modify-write cycle, run on a client that is inside a transaction. */
  const applyMovement = async (trx: Db): Promise<WalletAdjustResult> => {
    // Take the user row's write lock before reading the balance, so a
    // concurrent adjustWallet for this same user blocks here and reads our
    // committed result instead of the value we are about to replace. A
    // missing user returns no row and falls through to the findUniqueOrThrow
    // below, which raises the same not-found error it always did.
    await trx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = await trx.user.findUniqueOrThrow({ where: { id: userId } });
    const oldBalance = new Decimal(currency === "USDT" ? user.walletBalanceUsdt : user.walletBalance);
    const newBalance = quantizeMoney(oldBalance.plus(delta), 4);
    if (newBalance.lessThan(0) && !opts.allowNegative) {
      throw new ValidationError("error.insufficient_wallet");
    }
    // Ledger row FIRST, balance second — the order matters (Task E5 item 2).
    // `wallet_transactions` is UNIQUE on (orderId, reason), so this insert can
    // legitimately fail: it is what stops one order being credited twice if a
    // caller's own guard is ever bypassed. Writing the balance first would move
    // the buyer's money and only then discover the movement is a duplicate. The
    // transaction this now always runs in would roll that back, but inserting
    // first keeps the rejection safe on its own terms — it aborts before any
    // money moves instead of relying on a rollback to undo it, which is what
    // kept the balance and the ledger from permanently disagreeing back when
    // callers could reach this with no transaction at all. Both writes use
    // `newBalance`, which was computed above, so neither depends on the other
    // having run.
    const movement = await trx.walletTransaction.create({
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
    await trx.user.update({
      where: { id: userId },
      data: currency === "USDT" ? { walletBalanceUsdt: newBalance } : { walletBalance: newBalance },
    });
    return { balance: newBalance, transactionId: movement.id };
  };

  // A `Tx` has no `$transaction` (Prisma strips it from the interactive
  // transaction client), so its presence is what distinguishes the bare client
  // from a caller-owned transaction.
  const ownsTransaction = "$transaction" in db && typeof db.$transaction === "function";
  const result = ownsTransaction ? await db.$transaction(applyMovement) : await applyMovement(db);
  invalidateWarmUser(userId);
  return result;
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
  return db.user.findMany({ where: { OR: or }, take: limit, select: SEARCH_USER_SELECT });
}

/**
 * Every spend figure in this file is the sum of TWO legs of the same purchase
 * (Financial Ledger M8.5): `Order.totalAmount`, which is only what the buyer
 * owed EXTERNALLY (the checkout paths write it net of `walletUsed`), plus the
 * wallet credit spent on that order, read from its own `order_payment`
 * `WalletTransaction` rows. Before this, a purchase paid from wallet credit
 * looked like a smaller purchase — and one paid entirely from credit like no
 * purchase at all — while the ledger's `postOrderPaymentPosting` already
 * recognised the whole sale.
 *
 * Funding the wallet was never counted as spend (`SPEND_KIND_FILTER`, Task 6a)
 * precisely because the money was still the buyer's at that point; this is the
 * other half of that same rule — spending the credit is when it stops being
 * theirs. The two fixes only make sense together: with just the first, a
 * wallet-funded customer's spend is understated; with just the second, it is
 * double-counted.
 *
 * See `walletSpendByCurrency`/`walletSpendByUser` (crud/revenue.ts) for why the
 * legs are grouped by the wallet row's OWN currency and why only
 * `order_payment` rows count.
 */
const SPEND_WHERE = (extra: Record<string, unknown>) => ({
  ...extra,
  status: OrderStatus.DELIVERED,
  ...SPEND_KIND_FILTER,
});

/**
 * How much this user has SPENT: their DELIVERED product-order totals plus the
 * wallet credit spent on those orders, split per transaction currency (orders
 * predating the currency column count as USDT — their snapshot unit).
 *
 * Product orders only (`SPEND_KIND_FILTER`) — funding a wallet is not
 * spending. Spending that credit is (see `SPEND_WHERE` above).
 */
export async function userTotalSpent(
  db: Db,
  userId: number,
): Promise<{ idr: Decimal; usdt: Decimal }> {
  const where = SPEND_WHERE({ userId });
  const groups = await db.order.groupBy({
    by: ["currency"],
    where,
    _sum: { totalAmount: true },
  });
  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  for (const g of groups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum);
    else usdt = usdt.plus(sum);
  }
  const wallet = await walletSpendByCurrency(db, where);
  return { idr: idr.plus(wallet.idr), usdt: usdt.plus(wallet.usdt) };
}

/** Batched DELIVERED product-order totals for a page of users, split per
 * transaction currency (orders predating the currency column count as USDT —
 * their snapshot unit). One `groupBy` for the whole page instead of one query
 * per row (the N+1 pattern `userTotalSpent` has when called per-row). Users
 * with no DELIVERED product orders are absent from the returned Map — callers
 * should default to `{ idr: new Decimal(0), usdt: new Decimal(0) }` on a miss,
 * which is also what a top-up-only customer now falls back to
 * (`SPEND_KIND_FILTER`). */
export async function totalSpentByUserIds(
  db: Db,
  userIds: number[],
): Promise<Map<number, { idr: Decimal; usdt: Decimal }>> {
  const result = new Map<number, { idr: Decimal; usdt: Decimal }>();
  if (userIds.length === 0) return result;
  const where = SPEND_WHERE({ userId: { in: userIds } });
  const groups = await db.order.groupBy({
    by: ["userId", "currency"],
    where,
    _sum: { totalAmount: true },
  });
  for (const g of groups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    const entry = result.get(g.userId) ?? { idr: new Decimal(0), usdt: new Decimal(0) };
    if (g.currency === "IDR") entry.idr = entry.idr.plus(sum);
    else entry.usdt = entry.usdt.plus(sum);
    result.set(g.userId, entry);
  }
  // The wallet half of the same purchases, attributed to the buyer who spent
  // the credit (M8.5). A user reached only through this half still belongs in
  // the Map: their whole purchase was paid from credit.
  for (const [userId, wallet] of await walletSpendByUser(db, where)) {
    const entry = result.get(userId) ?? { idr: new Decimal(0), usdt: new Decimal(0) };
    result.set(userId, { idr: entry.idr.plus(wallet.idr), usdt: entry.usdt.plus(wallet.usdt) });
  }
  return result;
}

/** Lifetime order count per user (any status, any kind), batched for a page of
 * users — same batching shape as totalSpentByUserIds. Users with zero orders
 * are absent from the returned Map.
 *
 * Left kind-agnostic by Financial Ledger M6 (Task 6a) because it has no callers
 * at all: `orderStatsByUserIds.totalOrders` superseded it for the Customers
 * page, and that field is itself deliberately all-kinds account activity. There
 * is therefore no sales context here to correct — a filter would be inventing a
 * semantic for a function nobody calls. If a caller appears, decide then which
 * of the two questions it is asking. */
export async function orderCountByUserIds(db: Db, userIds: number[]): Promise<Map<number, number>> {
  const result = new Map<number, number>();
  if (userIds.length === 0) return result;
  const groups = await db.order.groupBy({
    by: ["userId"],
    where: { userId: { in: userIds } },
    _count: { _all: true },
  });
  for (const g of groups) result.set(g.userId, g._count._all);
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

/** The only User columns the global wallet-transactions page needs, as an
 *  explicit `select` on the relation. Never `include: { user: true }` here:
 *  that would pull `passwordHash` and `email` into a web-admin JSON response.
 *  Same rule and reasoning as USER_SELECT above, narrowed to a display label.
 *  These four columns are read only to build `customerLabel` — the relation
 *  itself is not returned, so nothing here reaches the wire directly. */
const WALLET_TX_USER_SELECT = {
  id: true,
  username: true,
  fullName: true,
  telegramId: true,
} as const;

/** Every `reason` code `adjustWallet` writes into `wallet_transactions`, in
 *  the order the schema comment lists them (prisma/schema.prisma). Exported so
 *  the admin page's reason dropdown and the route's validation share one list
 *  instead of each hard-coding its own copy. Keep in sync with the schema
 *  comment when a new reason is introduced.
 *
 *  This list is a FILTER vocabulary for the wallet-ledger admin page, not a
 *  write-side allowlist — every writer passes its own literal, and the only
 *  admin-initiated one is hard-coded `admin_adjust` (web-admin's users route
 *  and the bot's admin handler). So a reason missing from here does not block
 *  any write; it just makes those rows impossible to isolate in the admin UI,
 *  which is exactly what happened to `unfulfilled_credit` (written by
 *  `creditOrderToBalance`, crud/orders.ts) until Task E5's audit of every
 *  order-scoped reason turned it up. */
export const WALLET_TX_REASONS = [
  "admin_adjust",
  "underpaid_refund",
  "referral",
  "order_payment",
  "order_refund",
  "adjust",
  "wallet_topup",
  "unfulfilled_credit",
  // Written by `executeRefund` (crud/refunds.ts) for a WALLET refund payout.
  // Deliberately distinct from `underpaid_refund` and `unfulfilled_credit`,
  // which are the two narrow, order-specific credit paths that predate the
  // general-purpose refund payout — an admin filtering the wallet ledger for
  // "money we handed back through the refund workflow" must not have to pick
  // those apart from it. It is also the one order-adjacent reason that
  // deliberately stores NO orderId, because the same order can legitimately be
  // refunded more than once; see `executeRefund` for why.
  "refund_execution",
] as const;

export interface WalletTransactionFilter {
  userId?: number | null;
  /** Machine reason code as stored: admin_adjust | underpaid_refund |
   *  referral | order_payment | order_refund | adjust | wallet_topup |
   *  unfulfilled_credit | refund_execution. */
  reason?: string | null;
  currency?: string | null;
  /** createdAt >= from */
  from?: Date | null;
  /** createdAt <= to */
  to?: Date | null;
}

export interface GlobalWalletTransactionRow {
  id: number;
  createdAt: Date;
  userId: number;
  /** Display name for the customer: `username`, else `fullName`, else
   *  `Telegram <telegramId>`, else `Customer #<userId>`. Close to but
   *  deliberately not identical to `recentOrders`' label (reports.ts), which
   *  skips `fullName` and ends at "Unknown customer" — so a customer with no
   *  username but a filled-in `fullName` reads as their name here and as
   *  "Telegram <id>" there. This chain is the fuller one; if the two are ever
   *  unified, unify on this one. */
  customerLabel: string;
  /** Signed: positive credits the wallet, negative debits it. */
  delta: string;
  balanceAfter: string;
  currency: string;
  reason: string;
  note: string;
  adminId: number | null;
  orderId: number | null;
}

function walletTransactionWhere(f: WalletTransactionFilter): Prisma.WalletTransactionWhereInput {
  const where: Prisma.WalletTransactionWhereInput = {};
  if (f.userId != null) where.userId = f.userId;
  if (f.reason) where.reason = f.reason;
  if (f.currency) where.currency = f.currency;
  if (f.from || f.to) {
    where.createdAt = {
      ...(f.from ? { gte: f.from } : {}),
      ...(f.to ? { lte: f.to } : {}),
    };
  }
  return where;
}

/**
 * Every wallet movement across all users, newest first — the global
 * counterpart to `listWalletLedger`, which is locked to one `userId` and is
 * therefore only reachable from a single customer's detail page. Wallet
 * top-ups (`reason: "wallet_topup"`, written by `adjustWallet`) had no
 * shop-wide view at all before this.
 *
 * Ordered by `id desc` rather than `createdAt desc`: the ledger is
 * append-only, so the primary key already encodes insertion order and sorting
 * on it needs no extra index.
 *
 * Indexing, deliberately: `WalletTransaction` carries only `@@index([userId])`
 * (prisma/schema.prisma), so filtering by `reason`/`currency`/`createdAt`
 * full-scans the table. That is accepted at this table's size — this repo
 * deploys schema with `prisma db push`, and adding an index here would mean a
 * live schema change for a page an admin opens occasionally. Revisit if the
 * ledger grows into the hundreds of thousands of rows.
 */
export async function listAllWalletTransactions(
  db: Db,
  opts: WalletTransactionFilter & { limit?: number; offset?: number } = {},
): Promise<GlobalWalletTransactionRow[]> {
  const rows = await db.walletTransaction.findMany({
    where: walletTransactionWhere(opts),
    orderBy: { id: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 50,
    include: { user: { select: WALLET_TX_USER_SELECT } },
  });
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    userId: r.userId,
    customerLabel:
      r.user?.username ??
      r.user?.fullName ??
      (r.user?.telegramId != null ? `Telegram ${r.user.telegramId}` : `Customer #${r.userId}`),
    delta: new Decimal(r.delta).toString(),
    balanceAfter: new Decimal(r.balanceAfter).toString(),
    currency: r.currency,
    reason: r.reason,
    note: r.note ?? "",
    adminId: r.adminId,
    orderId: r.orderId,
  }));
}

/** Row count for `listAllWalletTransactions`'s filter — the page's pagination
 *  total. Unlike the Payments ledger's cross-table merge, every filter here
 *  maps to a plain `where`, so a real `count()` is both possible and exact. */
export function countAllWalletTransactions(db: Db, opts: WalletTransactionFilter = {}): Promise<number> {
  return db.walletTransaction.count({ where: walletTransactionWhere(opts) });
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
 * One page of the real-spend side of the "sort by spend" ranking, ordered by
 * the SAME figure the "Total Spent" column shows: gateway leg
 * (`Order.totalAmount`) plus the IDR wallet credit spent on those same orders
 * (Financial Ledger M8.5). Sorting on the gateway leg alone would have put a
 * customer who pays mostly from wallet credit below one who spent less in
 * total, directly contradicting the number rendered next to them on the same
 * row — the exact inconsistency Task 6a fixed `rankUserIdsBySpend` for in the
 * first place.
 *
 * Only the IDR leg is added, because this ranking is IDR-only by design (see
 * `rankUserIdsBySpend`). A USDT wallet leg on an IDR order is not a shape the
 * checkout paths produce, and blending it in would fabricate the single scalar
 * that design exists to refuse.
 *
 * **Why the ranking can still be paginated without materializing the whole
 * customer base.** `groupBy` can order by `_sum(totalAmount)` in SQL, but not
 * by that sum plus a figure from another table, so the final ordering has to
 * happen in JS. It only needs the right CANDIDATES to be correct, and they are
 * bounded by the page's depth:
 *
 *   - `T` = the top `offset + limit` customers by gateway spend alone, ranked
 *     and truncated in SQL.
 *   - `W` = every customer with IDR wallet spend on a qualifying order.
 *
 * Adding wallet spend only ever moves a customer UP. So a customer who is not
 * in `W` and not in `T` has at least `offset + limit` customers ranked above
 * them under the combined figure too, and therefore cannot appear on this page.
 * `T ∪ W` is thus a superset of the true page, and sorting it by (combined
 * DESC, userId ASC) — a total order, so successive pages cannot duplicate or
 * drop a row — and slicing `[offset, offset + limit)` gives exactly the right
 * ids. `W` is bounded by how many customers have ever paid from credit, not by
 * the customer base; deep pages read proportionally deeper, which is the one
 * cost this correction adds over the old skip/take.
 */
async function rankedPageBySpend(
  db: Db,
  where: Prisma.UserWhereInput,
  offset: number,
  limit: number,
  rankedCount: number,
): Promise<number[]> {
  const rankedWhere = {
    status: OrderStatus.DELIVERED,
    currency: "IDR",
    ...SPEND_KIND_FILTER,
    user: where,
  };
  const depth = Math.min(offset + limit, rankedCount);
  const [byGateway, walletByUser] = await Promise.all([
    db.order.groupBy({
      by: ["userId"],
      where: rankedWhere,
      _sum: { totalAmount: true },
      // The secondary key makes the truncation at `depth` deterministic when
      // two customers' gateway spend ties, which is what lets the JS sort below
      // reproduce one stable total order across pages.
      orderBy: [{ _sum: { totalAmount: "desc" } }, { userId: "asc" }],
      take: depth,
    }),
    walletSpendByUser(db, rankedWhere),
  ]);

  const combined = new Map<number, Decimal>();
  for (const group of byGateway) combined.set(group.userId, new Decimal(group._sum.totalAmount ?? 0));

  // A wallet-heavy customer can sit outside the gateway-ranked slice (in the
  // extreme, with a gateway spend of zero), so their own gateway figure is read
  // here rather than assumed to be in `byGateway` already.
  const missing = [...walletByUser.keys()].filter((userId) => !combined.has(userId));
  if (missing.length > 0) {
    const extra = await db.order.groupBy({
      by: ["userId"],
      where: { ...rankedWhere, userId: { in: missing } },
      _sum: { totalAmount: true },
    });
    for (const group of extra) combined.set(group.userId, new Decimal(group._sum.totalAmount ?? 0));
  }

  for (const [userId, wallet] of walletByUser) {
    const gateway = combined.get(userId);
    // No qualifying order for this customer means their credit was spent on
    // something this ranking does not count (a USDT order, say) — not a row to
    // invent here.
    if (gateway == null) continue;
    combined.set(userId, gateway.plus(wallet.idr));
  }

  return [...combined.entries()]
    .sort(([leftId, leftSpend], [rightId, rightSpend]) =>
      rightSpend.comparedTo(leftSpend) || leftId - rightId,
    )
    .slice(offset, offset + limit)
    .map(([userId]) => userId);
}

/**
 * Rank a filtered set of user ids by DELIVERED-order IDR spend, descending,
 * then return the requested page of ids. A single `findMany` relation-orderBy
 * cannot sort by a child relation's `_sum`, only `_count` — this ranks via a
 * `groupBy` on `Order` because `groupBy` DOES support ordering by `_sum`.
 *
 * IDR-only, deliberately — spend is inherently two numbers (IDR, USDT) and
 * blending them into one ranking would fabricate a single scalar
 * (`CurrencyStack` exists specifically to avoid exactly that). Users with no
 * DELIVERED IDR orders (including USDT-only spenders) rank as zero-IDR-
 * spenders, appended after every real IDR spender in their original
 * createdAt-desc order.
 *
 * Product orders only (`SPEND_KIND_FILTER`), on all three of its queries at
 * once — the ranked slice, the `rankedCount` that decides where the ranked side
 * ends, and the zero-spender `orders: { none: ... }` complement must agree on
 * what "has spent something" means, or a customer lands on both sides of the
 * boundary (or neither) and a page silently duplicates or drops rows. A
 * top-up-only customer is a zero spender here, which is also exactly what
 * `totalSpentByUserIds` now reports for the same row: this ranking and the
 * "Total Spent" column it sorts are the same question on one screen.
 *
 * Bounded, not the "materialize every matched id, then groupBy over all of
 * them, then slice" shape this replaced (which pulled every filtered user id
 * — unbounded on a large customer base — before ranking a single page and
 * discarding the rest, and made `groupBy` chunk its `userId IN (...)` list
 * around SQLite's parameter-count limit). Instead:
 *   1. Count how many matched users have >=1 DELIVERED IDR order at all
 *      (`rankedCount`) — an indexed EXISTS-style count, not a row pull.
 *   2. If the requested page overlaps the ranked (real-spend) side, take that
 *      page from `rankedPageBySpend` below, which bounds its own reads by the
 *      page's depth rather than by the customer base.
 *   3. If the page still needs more rows after that, pull the remainder from
 *      the zero-spend side directly via `orders: { none: {...} } }`,
 *      createdAt-desc, again with `skip`/`take` doing the pagination in SQL.
 * Nothing unbounded by customer-base size is ever materialized, while the
 * ordering and pagination stay the ones
 * `packages/db/src/crud/users.test.ts`'s boundary-page assertions pin.
 */
async function rankUserIdsBySpend(
  db: Db,
  where: Prisma.UserWhereInput,
  offset: number,
  limit: number,
): Promise<number[]> {
  if (limit <= 0) return [];

  const hasDeliveredIdrOrder: Prisma.UserWhereInput = {
    orders: { some: { status: OrderStatus.DELIVERED, currency: "IDR", ...SPEND_KIND_FILTER } },
  };
  const rankedCount = await db.user.count({ where: { ...where, ...hasDeliveredIdrOrder } });

  const result: number[] = [];

  if (offset < rankedCount) {
    result.push(...(await rankedPageBySpend(db, where, offset, limit, rankedCount)));
  }

  const remaining = limit - result.length;
  if (remaining > 0) {
    const zeroSpenders = await db.user.findMany({
      where: { ...where, orders: { none: { status: OrderStatus.DELIVERED, currency: "IDR", ...SPEND_KIND_FILTER } } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      skip: Math.max(0, offset - rankedCount),
      take: remaining,
    });
    result.push(...zeroSpenders.map((u) => u.id));
  }

  return result;
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
    const rows = await db.user.findMany({ where: { id: { in: pageIds } }, select: USER_SELECT });
    const byId = new Map(rows.map((u) => [u.id, u]));
    return pageIds.map((id) => byId.get(id)).filter((u): u is (typeof rows)[number] => u != null);
  }

  return db.user.findMany({ where, orderBy: userOrderBy(opts.sort), skip: offset, take: limit, select: USER_SELECT });
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
 * `returningCustomers` counts users with >=2 DELIVERED product orders — a user
 * with 1 DELIVERED + 3 PENDING does not count, and neither does one with 2
 * settled wallet top-ups (`SPEND_KIND_FILTER`; a repeat customer is a repeat
 * BUYER, and this must agree with the per-row "RETURNING" badge, which reads
 * `orderStatsByUserIds.deliveredOrders`). `totalRevenue` is all-time (distinct
 * from Orders' "Revenue Today"), DELIVERED product orders only, counting both
 * legs of each sale — what was charged externally plus the wallet credit spent
 * on it (see `SPEND_WHERE`).
 *
 * `newToday`/`activeToday` are not order-derived (they read `User.createdAt`/
 * `lastSeenAt`), so the kind filter does not apply to them.
 */
export async function customersKpis(db: Db): Promise<CustomersKpis> {
  const todayStart = startOfDayUtc();
  const nonAdmin = { role: { in: NON_ADMIN_ROLES } };
  const customerSales = SPEND_WHERE({ user: nonAdmin });
  const [totalCustomers, newToday, activeToday, returningGroups, revenueGroups, walletSpend] = await Promise.all([
    db.user.count({ where: nonAdmin }),
    db.user.count({ where: { ...nonAdmin, createdAt: { gte: todayStart } } }),
    db.user.count({ where: { ...nonAdmin, lastSeenAt: { gte: todayStart } } }),
    db.order.groupBy({ by: ["userId"], where: customerSales, _count: { _all: true } }),
    db.order.groupBy({ by: ["currency"], where: customerSales, _sum: { totalAmount: true } }),
    // The wallet half of those same sales (M8.5). `returningCustomers` needs no
    // such term: it counts purchases, and a wallet-paid purchase is already one
    // order row in the group above.
    walletSpendByCurrency(db, customerSales),
  ]);

  const returningCustomers = returningGroups.filter((g) => g._count._all >= 2).length;

  let idr = new Decimal(0);
  let usdt = new Decimal(0);
  for (const g of revenueGroups) {
    const sum = new Decimal(g._sum.totalAmount ?? 0);
    if (g.currency === "IDR") idr = idr.plus(sum); else usdt = usdt.plus(sum);
  }
  return {
    totalCustomers,
    newToday,
    activeToday,
    returningCustomers,
    totalRevenue: { idr: idr.plus(walletSpend.idr), usdt: usdt.plus(walletSpend.usdt) },
  };
}

export interface UserOrderStats {
  /** Any status, ANY KIND — account activity, not purchases. See the function's
   * doc comment for why this one is not narrowed to PRODUCT. */
  totalOrders: number;
  /** Max createdAt, any status, any kind — same account-activity framing. */
  lastOrderAt: Date | null;
  /** DELIVERED PRODUCT orders only — feeds the per-row "Returning" badge
   * (>= 2) in Task 5, the same concept `customersKpis.returningCustomers`
   * counts page-wide. */
  deliveredOrders: number;
}

/**
 * Batched per-user order stats for a page of users — exactly 3 `groupBy`
 * calls total for the whole page (never one query per user), mirroring
 * `totalSpentByUserIds`'s existing batching discipline. Users with zero
 * orders are absent from the returned Map.
 *
 * The three fields answer two DIFFERENT questions and Financial Ledger M6
 * (Task 6a) split them accordingly rather than filtering the whole function:
 *
 *  - `totalOrders`/`lastOrderAt` feed the Customers page's "Orders" and "Last
 *    Order" columns and the customers CSV export — an admin looking at an
 *    account's activity. A wallet top-up IS activity on that account (and is
 *    visible as its own row on the Orders page), so they stay all-kinds.
 *  - `deliveredOrders` exists only to drive the "RETURNING" badge (>= 2), which
 *    is the per-row form of `customersKpis.returningCustomers`. That KPI counts
 *    repeat BUYERS and now excludes top-ups, so this must too — otherwise a
 *    customer with two top-ups and no purchase would wear a "Returning" badge
 *    on a page whose own KPI refused to count them.
 */
export async function orderStatsByUserIds(db: Db, userIds: number[]): Promise<Map<number, UserOrderStats>> {
  const result = new Map<number, UserOrderStats>();
  if (userIds.length === 0) return result;

  const [counts, lastOrders, delivered] = await Promise.all([
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _count: { _all: true } }),
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds } }, _max: { createdAt: true } }),
    db.order.groupBy({ by: ["userId"], where: { userId: { in: userIds }, status: OrderStatus.DELIVERED, ...SPEND_KIND_FILTER }, _count: { _all: true } }),
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
 *
 * Best-effort and self-logging (touchLastSeen never throws) — a DB failure
 * here must never crash the app. The update is idempotent and only affects
 * the 'Active Today' KPI, not the customer's session.
 */
export async function touchLastSeen(db: Db, userId: number): Promise<void> {
  const lastTouch = lastSeenTouchedAt.get(userId);
  const now = Date.now();
  if (lastTouch != null && now - lastTouch < LAST_SEEN_TOUCH_TTL_MS) return;
  lastSeenTouchedAt.set(userId, now);
  try {
    await db.user.update({ where: { id: userId }, data: { lastSeenAt: new Date(now) } });
  } catch (err) {
    logger.error({ err, userId }, "Failed to update a customer's last-seen timestamp from storefront activity — this only affects the 'Active Today' admin KPI, not the customer's session.");
  }
}
