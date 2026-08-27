/**
 * Audit log — port of the "Audit log" section of crud.py.
 *
 * Two actor kinds share the same `audit_logs` table (Phase H, customer-action
 * audit trail): admin-initiated entries (`logAdminAction`, unchanged —
 * `actorType` is omitted from its insert, so Postgres applies the schema's
 * `@default("ADMIN")` automatically) and customer-initiated entries
 * (`logCustomerAction`, a thin wrapper over the same underlying insert with
 * `actorType: "CUSTOMER"` fixed and the customer-identifying columns wired
 * through). Both funnel through `insertAuditLog` to avoid duplicating the
 * `db.auditLog.create` call.
 */
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";

interface InsertAuditLogArgs {
  adminId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: number | null;
  details?: string | null;
  actorType?: string;
  channel?: string | null;
  customerId?: number | null;
  telegramUserId?: bigint | null;
  correlationId?: string | null;
}

function insertAuditLog(db: Db, args: InsertAuditLogArgs) {
  return db.auditLog.create({
    data: {
      adminId: args.adminId ?? null,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      details: args.details ?? null,
      ...(args.actorType != null ? { actorType: args.actorType } : {}),
      channel: args.channel ?? null,
      customerId: args.customerId ?? null,
      telegramUserId: args.telegramUserId ?? null,
      correlationId: args.correlationId ?? null,
    },
  });
}

export async function logAdminAction(
  db: Db,
  args: {
    adminId: number | null;
    action: string;
    targetType?: string | null;
    targetId?: number | null;
    details?: string | null;
  },
) {
  await insertAuditLog(db, args);
}

/**
 * Customer-initiated counterpart to `logAdminAction` (Phase H). `actorType`
 * is always "CUSTOMER" — callers don't set it. `customerId` is nullable to
 * match `logAdminAction`'s `adminId` (an acting party can be unresolved),
 * but callers should pass it whenever the acting customer is known.
 */
export async function logCustomerAction(
  db: Db,
  args: {
    customerId: number | null;
    telegramUserId?: bigint | null;
    channel?: string | null;
    action: string;
    targetType?: string | null;
    targetId?: number | null;
    details?: string | null;
    correlationId?: string | null;
  },
) {
  await insertAuditLog(db, {
    ...args,
    adminId: null,
    actorType: "CUSTOMER",
  });
}

export interface AuditFilter {
  adminId?: number | null;
  action?: string | null;
  targetType?: string | null;
  targetId?: number | null;
  since?: Date | null;
  until?: Date | null;
  actorType?: string | null;
  customerId?: number | null;
}

function auditWhere(f: AuditFilter): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (f.adminId != null) where.adminId = f.adminId;
  if (f.action) where.action = f.action;
  if (f.targetType) where.targetType = f.targetType;
  if (f.targetId != null) where.targetId = f.targetId;
  if (f.actorType) where.actorType = f.actorType;
  if (f.customerId != null) where.customerId = f.customerId;
  if (f.since != null || f.until != null) {
    where.createdAt = {};
    if (f.since != null) where.createdAt.gte = f.since;
    if (f.until != null) where.createdAt.lte = f.until;
  }
  return where;
}

export function listAuditLogs(
  db: Db,
  opts: AuditFilter & { limit?: number; offset?: number } = {},
) {
  return db.auditLog.findMany({
    where: auditWhere(opts),
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 100,
  });
}

export function countAuditLogs(db: Db, opts: AuditFilter = {}) {
  return db.auditLog.count({ where: auditWhere(opts) });
}
