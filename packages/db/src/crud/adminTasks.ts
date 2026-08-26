/**
 * AdminTask domain — the manual-operation task queue crud + state machine
 * (Trustance Master Architecture Task 9a, §38).
 *
 * SCOPE: this is schema+crud only. No route/UI reads or writes this table
 * yet (Task 9b). This is a NEW, separate, persisted entity — do not confuse
 * it with the read-only, live-derived counters `GET /api/dashboard/
 * operations` computes directly from Order/Payment-adjacent tables
 * (apps/web-admin/src/routes/api/dashboard.ts, OperationCenter.tsx). Nothing
 * here reads or writes that endpoint's tables, and nothing there reads this
 * one.
 *
 * Follows this repo's established state-machine-on-a-string-column pattern
 * (packages/db/src/crud/refunds.ts's `transitionRefundStatus`, packages/db/
 * src/crud/orderStatus.ts's `transitionOrderStatus`): a `LEGAL_TRANSITIONS`
 * lookup table, an atomic claim via `updateMany` with the expected current
 * status in the WHERE clause (so a stale/duplicate caller fails safely
 * instead of clobbering a task that already moved on), and an audit row via
 * `logAdminAction` for every creation and every transition.
 */
import { AdminTaskPriority, AdminTaskStatus, AdminTaskType, UserRole } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import type { AdminTask, Prisma } from "@prisma/client";
import type { Db } from "./_types";
import { logAdminAction } from "./audit";

/**
 * Legal AdminTask.status transitions, driven by the four admin actions §38
 * names (Assign / Start / Complete / Escalate) — see AdminTaskStatus's own
 * doc comment (@app/core/enums) for the full state-machine diagram and
 * reasoning. Each of the four action wrapper functions below fixes exactly
 * one `to` status; the caller-supplied `from` must appear in this table's
 * entry for it to succeed.
 *
 *   PENDING    -> ASSIGNED (assign) | ESCALATED (escalate)
 *   ASSIGNED   -> IN_PROGRESS (start) | ESCALATED (escalate)
 *   IN_PROGRESS-> COMPLETED (complete) | ESCALATED (escalate)
 *   ESCALATED  -> ASSIGNED (assign, reassign/hand off) | IN_PROGRESS (start,
 *                 resume directly) | COMPLETED (complete, resolved as-is)
 *   COMPLETED  -> (terminal, no outgoing edges)
 *
 * PENDING has no `start`/`complete` edge: this repo's convention (mirrored
 * from Refund/Order) is that a task must be assigned before work begins —
 * "start" always requires an existing ASSIGNED/ESCALATED row. There is no
 * outgoing edge back to PENDING from anywhere (no "unassign" action in
 * §38's action list) — closing that gap is future work if it's ever needed.
 */
export const ADMIN_TASK_LEGAL_TRANSITIONS: Record<string, readonly string[]> = {
  [AdminTaskStatus.PENDING]: [AdminTaskStatus.ASSIGNED, AdminTaskStatus.ESCALATED],
  [AdminTaskStatus.ASSIGNED]: [AdminTaskStatus.IN_PROGRESS, AdminTaskStatus.ESCALATED],
  [AdminTaskStatus.IN_PROGRESS]: [AdminTaskStatus.COMPLETED, AdminTaskStatus.ESCALATED],
  [AdminTaskStatus.ESCALATED]: [
    AdminTaskStatus.ASSIGNED,
    AdminTaskStatus.IN_PROGRESS,
    AdminTaskStatus.COMPLETED,
  ],
  [AdminTaskStatus.COMPLETED]: [],
};

/**
 * Create a new AdminTask, starting PENDING and unassigned (the schema
 * defaults) — assignment is a deliberate separate action (`assignAdminTask`),
 * not something creation does implicitly.
 *
 * Validates `type`/`priority` against their enum value sets (a clean
 * ValidationError, not a silently-stored garbage string), and — when given —
 * that `orderId`/`orderItemId`/`refundId` each reference a real row and stay
 * mutually consistent (an `orderItemId` must belong to the given `orderId`;
 * a `refundId` must belong to the given `orderId`), the same cross-reference
 * shape `createRefundItem` already enforces for its own orderId/refundId
 * pair. All three references are independently optional — a task type that
 * needs no order context at all is representable, same as a general
 * SupportTicket with no orderId.
 *
 * Audits the creation via `logAdminAction` (`admin_task_created`), same
 * pattern as `createRefund`.
 */
export async function createAdminTask(
  db: Db,
  args: {
    type: string;
    orderId?: number | null;
    orderItemId?: number | null;
    refundId?: number | null;
    priority?: string;
    dueAt?: Date | null;
    adminId: number;
  },
): Promise<AdminTask> {
  if (!Object.values(AdminTaskType).includes(args.type as AdminTaskType)) {
    throw new ValidationError("error.admin_task_type_invalid", { type: args.type });
  }
  const priority = args.priority ?? AdminTaskPriority.MEDIUM;
  if (!Object.values(AdminTaskPriority).includes(priority as AdminTaskPriority)) {
    throw new ValidationError("error.admin_task_priority_invalid", { priority });
  }

  let order: { id: number; orderCode: string } | null = null;
  if (args.orderId != null) {
    order = await db.order.findUnique({
      where: { id: args.orderId },
      select: { id: true, orderCode: true },
    });
    if (!order) throw new ValidationError("error.order_not_found");
  }

  if (args.orderItemId != null) {
    const orderItem = await db.orderItem.findUnique({
      where: { id: args.orderItemId },
      select: { id: true, orderId: true },
    });
    if (!orderItem) throw new ValidationError("error.order_item_not_found");
    if (args.orderId != null && orderItem.orderId !== args.orderId) {
      throw new ValidationError("error.admin_task_order_item_mismatch");
    }
  }

  if (args.refundId != null) {
    const refund = await db.refund.findUnique({
      where: { id: args.refundId },
      select: { id: true, orderId: true },
    });
    if (!refund) throw new ValidationError("error.refund_not_found");
    if (args.orderId != null && refund.orderId !== args.orderId) {
      throw new ValidationError("error.admin_task_refund_order_mismatch");
    }
  }

  const task = await db.adminTask.create({
    data: {
      type: args.type,
      orderId: args.orderId ?? null,
      orderItemId: args.orderItemId ?? null,
      refundId: args.refundId ?? null,
      priority,
      dueAt: args.dueAt ?? null,
    },
  });

  await logAdminAction(db, {
    adminId: args.adminId,
    action: "admin_task_created",
    targetType: "admin_task",
    targetId: task.id,
    details: `Created a ${priority} ${args.type} task${order ? ` for order ${order.orderCode}` : ""}.`,
  });

  return task;
}

export interface AdminTaskFilter {
  status?: string;
  type?: string;
  assignedTo?: number;
  orderId?: number;
  priority?: string;
}

function adminTaskWhere(f: AdminTaskFilter): Prisma.AdminTaskWhereInput {
  const where: Prisma.AdminTaskWhereInput = {};
  if (f.status) where.status = f.status;
  if (f.type) where.type = f.type;
  if (f.assignedTo != null) where.assignedTo = f.assignedTo;
  if (f.orderId != null) where.orderId = f.orderId;
  if (f.priority) where.priority = f.priority;
  return where;
}

/**
 * AdminTasks (newest first), with their order/orderItem/refund/assignee
 * relations included — a future admin UI's task queue view needs this
 * context (order code, item, assignee name) without a second round trip
 * per row.
 */
export function listAdminTasks(
  db: Db,
  opts: AdminTaskFilter & { limit?: number; offset?: number } = {},
) {
  return db.adminTask.findMany({
    where: adminTaskWhere(opts),
    include: { order: true, orderItem: true, refund: true, assignee: true },
    orderBy: { createdAt: "desc" },
    skip: opts.offset ?? 0,
    take: opts.limit ?? 100,
  });
}

export function countAdminTasks(db: Db, opts: AdminTaskFilter = {}) {
  return db.adminTask.count({ where: adminTaskWhere(opts) });
}

/**
 * Move an AdminTask from `from` to `to`: validates the shape against
 * `ADMIN_TASK_LEGAL_TRANSITIONS`, atomically claims the row (`updateMany`
 * with the expected current status in the WHERE clause — same pattern as
 * `transitionRefundStatus`/`transitionOrderStatus`), optionally sets
 * `assignedTo` in the SAME atomic write when provided (so a task can never
 * observably reach ASSIGNED with a stale/null assignee under a race), stamps
 * `completedAt` the moment the row reaches COMPLETED, and audits the move.
 *
 * Not exported — callers use the four action-specific wrappers below
 * (`assignAdminTask`/`startAdminTask`/`completeAdminTask`/
 * `escalateAdminTask`), which each fix `to` to the one status their action
 * name implies and add their own action-specific validation before
 * delegating here, mirroring how `transitionOrderStatus` stays a single
 * dumb, reusable state machine while callers keep their own business rules.
 */
async function transitionAdminTaskStatus(
  db: Db,
  args: {
    taskId: number;
    from: string;
    to: string;
    adminId: number;
    assignedTo?: number | null;
    meta?: string | null;
  },
): Promise<AdminTask> {
  const { taskId, from, to, adminId, meta } = args;

  if (!ADMIN_TASK_LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new ValidationError("error.illegal_admin_task_status_transition", { from, to });
  }

  // Unchecked (not the plain UpdateManyMutationInput) because `assignedTo`
  // is a relation scalar — Prisma's "checked" update input only allows
  // touching it via a nested relation connect/disconnect, not as a raw FK
  // value, which is exactly what the `assign` action needs to set here.
  const data: Prisma.AdminTaskUncheckedUpdateManyInput = { status: to };
  if (to === AdminTaskStatus.COMPLETED) data.completedAt = new Date();
  if (args.assignedTo !== undefined) data.assignedTo = args.assignedTo;

  const claim = await db.adminTask.updateMany({
    where: { id: taskId, status: from },
    data,
  });
  if (claim.count !== 1) {
    // Either the task doesn't exist, or its actual current status no longer
    // matches `from` (race/staleness) — same error either way, since both
    // mean "this transition cannot be applied as requested" (mirrors
    // transitionRefundStatus/transitionOrderStatus's own reasoning).
    throw new ValidationError("error.illegal_admin_task_status_transition", { from, to });
  }

  const task = await db.adminTask.findUniqueOrThrow({ where: { id: taskId } });

  await logAdminAction(db, {
    adminId,
    action: "admin_task_status_change",
    targetType: "admin_task",
    targetId: taskId,
    details: `Admin task #${taskId} (${task.type}) moved from ${from} to ${to}${meta ? ` (${meta})` : ""}.`,
  });

  return task;
}

/**
 * Assign an AdminTask to an admin: legal from PENDING (first assignment) or
 * ESCALATED (reassign/hand off after an escalation). Validates the assignee
 * exists and actually has role ADMIN (this repo's admins are User rows with
 * role=ADMIN, not a separate Admin table — same identity convention as
 * SupportTicket.adminId/logAdminAction's adminId) before the atomic claim, so
 * a task can never end up assigned to a non-admin/nonexistent user id.
 */
export async function assignAdminTask(
  db: Db,
  args: { taskId: number; from: string; assignedTo: number; adminId: number; meta?: string | null },
): Promise<AdminTask> {
  const assignee = await db.user.findUnique({
    where: { id: args.assignedTo },
    select: { id: true, role: true },
  });
  if (!assignee) throw new ValidationError("error.admin_task_assignee_not_found");
  if (assignee.role !== UserRole.ADMIN) {
    throw new ValidationError("error.admin_task_assignee_not_admin", { userId: args.assignedTo });
  }

  return transitionAdminTaskStatus(db, {
    taskId: args.taskId,
    from: args.from,
    to: AdminTaskStatus.ASSIGNED,
    adminId: args.adminId,
    assignedTo: args.assignedTo,
    meta: `assigned to admin ${args.assignedTo}${args.meta ? `; ${args.meta}` : ""}`,
  });
}

/** Start work on an AdminTask: legal from ASSIGNED or ESCALATED. */
export async function startAdminTask(
  db: Db,
  args: { taskId: number; from: string; adminId: number; meta?: string | null },
): Promise<AdminTask> {
  return transitionAdminTaskStatus(db, {
    taskId: args.taskId,
    from: args.from,
    to: AdminTaskStatus.IN_PROGRESS,
    adminId: args.adminId,
    meta: args.meta,
  });
}

/** Complete an AdminTask: legal from IN_PROGRESS or ESCALATED. Terminal. */
export async function completeAdminTask(
  db: Db,
  args: { taskId: number; from: string; adminId: number; meta?: string | null },
): Promise<AdminTask> {
  return transitionAdminTaskStatus(db, {
    taskId: args.taskId,
    from: args.from,
    to: AdminTaskStatus.COMPLETED,
    adminId: args.adminId,
    meta: args.meta,
  });
}

/**
 * Escalate an AdminTask: legal from PENDING, ASSIGNED, or IN_PROGRESS. Does
 * NOT clear `assignedTo` — an escalated task keeps whatever assignee it had
 * (if any), so `assignAdminTask` can hand it to someone else afterward, or
 * `startAdminTask`/`completeAdminTask` can resume it directly with the same
 * assignee still on the row.
 */
export async function escalateAdminTask(
  db: Db,
  args: { taskId: number; from: string; adminId: number; meta?: string | null },
): Promise<AdminTask> {
  return transitionAdminTaskStatus(db, {
    taskId: args.taskId,
    from: args.from,
    to: AdminTaskStatus.ESCALATED,
    adminId: args.adminId,
    meta: args.meta,
  });
}
