/**
 * Prisma client singleton — replacement for Python `database/session.py`.
 * Runs against Postgres, which enforces foreign keys and durable commits by
 * default and needs no per-connection setup statements.
 */
import { PrismaClient } from "@prisma/client";

// BigInt (telegram_id, etc.) must survive JSON.stringify in logs/web payloads.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (
  this: bigint,
) {
  return this.toString();
};

// Reuse a single client across hot-reloads in dev.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    transactionOptions: { maxWait: 5000, timeout: 10000 },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/**
 * No-op, kept only so the ~30 existing call sites across apps/scripts/tests
 * that `await initDb()` during boot/setup don't all need touching. Postgres
 * has no session-level setup an app needs to perform — foreign keys are always
 * enforced, and durability/concurrency are handled by the server. Left as an
 * async function (rather than deleted) purely for caller-compatibility; safe
 * to keep calling from every boot path.
 */
export async function initDb(): Promise<void> {
  // Intentionally empty — see doc comment above.
}

export type { PrismaClient } from "@prisma/client";
/** A Prisma transaction client (the `tx` passed to $transaction callbacks). */
export type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];
