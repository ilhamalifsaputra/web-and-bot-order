/**
 * Audit log — port of the "Audit log" section of crud.py.
 */
import type { Prisma } from "@prisma/client";
import type { Db } from "./_types";

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
  await db.auditLog.create({
    data: {
      adminId: args.adminId,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      details: args.details ?? null,
    },
  });
}

export interface AuditFilter {
  adminId?: number | null;
  action?: string | null;
  targetType?: string | null;
  since?: Date | null;
  until?: Date | null;
}

function auditWhere(f: AuditFilter): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (f.adminId != null) where.adminId = f.adminId;
  if (f.action) where.action = f.action;
  if (f.targetType) where.targetType = f.targetType;
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
