/**
 * Prisma client singleton — replacement for Python `database/session.py`.
 * Sets the same PRAGMAs the SQLAlchemy engine used (FK on, WAL) plus a
 * busy_timeout to avoid SQLITE_BUSY under concurrent writers. synchronous
 * is FULL, not the SQLAlchemy engine's original NORMAL — durability over
 * throughput on a single-VPS deployment (2026-08-26 decision).
 */
import { PrismaClient } from "@prisma/client";

// BigInt (telegram_id, etc.) must survive JSON.stringify in logs/web payloads.
// See migrate.md §11.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (
  this: bigint,
) {
  return this.toString();
};

/**
 * Whole-branch review finding I-4: SQLite PRAGMAs (foreign_keys,
 * busy_timeout, synchronous below) are per-CONNECTION, but Prisma's default
 * pool opens several physical connections (`num_cpus * 2 + 1`) — so
 * `initDb()` only ever applies them to whichever one connection happened to
 * serve that call, leaving every other pooled connection silently
 * un-PRAGMA'd. This repo's SQLite deployment is documented single-writer
 * (.claude/CLAUDE.md), so it only ever needs one physical connection anyway;
 * forcing the pool down to exactly one makes `initDb()`'s PRAGMAs cover every
 * connection that will ever exist, by construction.
 *
 * `connection_limit` isn't documented for SQLite `file:` URLs specifically
 * (Prisma's docs only show the query-param form for Postgres/MySQL), so this
 * was verified empirically against this repo's actual SQLite connector
 * before shipping: with no `connection_limit`, 40 concurrent queries against
 * a fresh temp DB opened 4 distinct physical connections (confirmed via
 * SQLite's connection-local `CREATE TEMP TABLE`); with `?connection_limit=1`
 * appended, the same 40-query burst used exactly 1 connection, the URL was
 * accepted without error, and a PRAGMA set on that one connection was then
 * visible on all 40 concurrent reads. Idempotent — a URL that already
 * specifies `connection_limit` (an operator's explicit override) is left
 * untouched.
 */
export function withConnectionLimit(url: string): string {
  if (/[?&]connection_limit=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}connection_limit=1`;
}

// Reuse a single client across hot-reloads in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Only override the datasource URL when DATABASE_URL_PRISMA is actually set —
// when it's missing, leave PrismaClient to read (and fail on) the schema's
// own env("DATABASE_URL_PRISMA") lookup exactly as before, rather than
// silently changing that failure behavior.
const datasourceUrl = process.env.DATABASE_URL_PRISMA
  ? withConnectionLimit(process.env.DATABASE_URL_PRISMA)
  : undefined;

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    ...(datasourceUrl ? { datasourceUrl } : {}),
    transactionOptions: { maxWait: 5000, timeout: 10000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

let initialized = false;

/** Apply SQLite PRAGMAs once. Idempotent. */
export async function initDb(): Promise<void> {
  if (initialized) return;
  // Use queryRawUnsafe: some PRAGMAs (journal_mode, busy_timeout) return a row,
  // which $executeRawUnsafe rejects on SQLite.
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$queryRawUnsafe("PRAGMA synchronous = FULL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  initialized = true;
}

export type { PrismaClient } from "@prisma/client";
/** A Prisma transaction client (the `tx` passed to $transaction callbacks). */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
