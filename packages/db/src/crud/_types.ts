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

/**
 * True if `e` is a unique-constraint violation on `column` (its snake_case
 * database name). A table with more than one unique column needs this to tell
 * WHICH value collided — e.g. a new user's telegram id (someone else created
 * the row first) from its random referral code (just retry). Prisma puts the
 * violated fields in `meta.target`, as column names or the index name; both
 * contain the column name, and the camelCase field name is matched too.
 */
export function isUniqueViolationOn(e: unknown, column: string): boolean {
  if (!isUniqueViolation(e)) return false;
  const raw = (e as { meta?: { target?: unknown } }).meta?.target;
  const target = Array.isArray(raw) ? raw.map(String).join(",") : String(raw ?? "");
  const camel = column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return target.includes(column) || target.includes(camel);
}
