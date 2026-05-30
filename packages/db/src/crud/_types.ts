import type { PrismaClient, Tx } from "../client";

/**
 * Every CRUD function takes a Prisma client OR a transaction client as its
 * first argument — the analogue of the SQLAlchemy `session` parameter. Pass
 * `prisma` for standalone calls, or the `tx` from `prisma.$transaction(...)`
 * to group multiple calls into one atomic unit (orders, approve, etc.).
 */
export type Db = PrismaClient | Tx;

/** True if a thrown error is a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code === "P2002"
  );
}
