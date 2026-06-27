/**
 * Prisma client singleton — replacement for Python `database/session.py`.
 * Sets the same PRAGMAs the SQLAlchemy engine used (FK on, WAL, synchronous
 * NORMAL) plus a busy_timeout to avoid SQLITE_BUSY under concurrent writers.
 */
import { PrismaClient } from "@prisma/client";

// BigInt (telegram_id, etc.) must survive JSON.stringify in logs/web payloads.
// See migrate.md §11.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (
  this: bigint,
) {
  return this.toString();
};

// Reuse a single client across hot-reloads in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

let initialized = false;

/** Apply SQLite PRAGMAs once. Idempotent. */
export async function initDb(): Promise<void> {
  if (initialized) return;
  // Use queryRawUnsafe: some PRAGMAs (journal_mode, busy_timeout) return a row,
  // which $executeRawUnsafe rejects on SQLite.
  await prisma.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  await prisma.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await prisma.$queryRawUnsafe("PRAGMA synchronous = NORMAL");
  await prisma.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  initialized = true;
}

export type { PrismaClient } from "@prisma/client";
/** A Prisma transaction client (the `tx` passed to $transaction callbacks). */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
