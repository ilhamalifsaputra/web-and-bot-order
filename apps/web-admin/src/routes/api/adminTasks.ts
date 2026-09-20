/**
 * JSON API for the admin task queue (Trustance Master Architecture Task 9b) —
 * the presentation layer over Task 9a's `packages/db/src/crud/adminTasks.ts`
 * crud + state machine. This is a NEW, separate surface from `GET /api/
 * dashboard/operations` (apps/web-admin/src/routes/api/dashboard.ts): that
 * endpoint's counters are read-only, live-derived from Order/Payment-adjacent
 * tables and are not touched here (see adminTasks.ts's own module comment).
 *
 * Follows this repo's support.ts route conventions: `currentAdmin` for reads,
 * `csrfProtect` for mutations (auth -> CSRF -> RBAC role gate — see
 * apps/web-admin/src/plugins/auth.ts's OPS_PREFIXES, which now includes
 * `/api/admin-tasks`), and a try/catch-ValidationError-\>422 pattern for the
 * four state-machine actions (mirrors orders.ts's /approve, /reject, /cancel,
 * /credit routes) rather than a separate existence check before each action —
 * `transitionAdminTaskStatus`'s atomic claim already treats "task doesn't
 * exist" and "task's status no longer matches `from`" as the same error, so
 * this route doesn't duplicate that check.
 */
import type { FastifyInstance } from "fastify";
import { AdminTaskType, AdminTaskPriority, AdminTaskStatus } from "@app/core/enums";
import { ValidationError } from "@app/core/errors";
import { errorBody } from "@app/core/errorBody";
import {
  prisma,
  listAdminTasks,
  countAdminTasks,
  listAdminTaskAssignees,
  assignAdminTask,
  startAdminTask,
  completeAdminTask,
  escalateAdminTask,
  type AdminTaskFilter,
} from "@app/db";
import { currentAdmin, csrfProtect } from "../../plugins/auth";
import { displayDateTime } from "../../dateDisplay";

const STATUS_VALUES = Object.values(AdminTaskStatus) as string[];
const TYPE_VALUES = Object.values(AdminTaskType) as string[];
const PRIORITY_VALUES = Object.values(AdminTaskPriority) as string[];
const PAGE_SIZE_OPTIONS = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 20;

/** Shared by the list route so the filter shape is exercised in one place —
 * mirrors `support.ts`'s `buildTicketFilter`. */
function buildAdminTaskFilter(q: Record<string, string | undefined>): AdminTaskFilter {
  const filter: AdminTaskFilter = {};
  if (q.status && STATUS_VALUES.includes(q.status)) filter.status = q.status;
  if (q.type && TYPE_VALUES.includes(q.type)) filter.type = q.type;
  if (q.priority && PRIORITY_VALUES.includes(q.priority)) filter.priority = q.priority;
  if (q.assignedTo === "unassigned") {
    filter.assignedTo = "unassigned";
  } else if (q.assignedTo != null) {
    const id = Number(q.assignedTo);
    if (Number.isInteger(id) && id > 0) filter.assignedTo = id;
  }
  return filter;
}

/** Only the fields the task queue row needs off a linked order/item/refund/
 * assignee — never spread a raw relation include into the response (same
 * projection discipline as support.ts's `ticketPartyUser`). */
function shapeTask(t: Awaited<ReturnType<typeof listAdminTasks>>[number]) {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    priority: t.priority,
    assignedTo: t.assignedTo,
    assigneeName: t.assignee
      ? (t.assignee.fullName ?? t.assignee.username ?? `Telegram ID ${t.assignee.telegramId}`)
      : null,
    order: t.order ? { id: t.order.id, orderCode: t.order.orderCode } : null,
    orderItem: t.orderItem
      ? { id: t.orderItem.id, quantity: t.orderItem.quantity, unitPrice: t.orderItem.unitPrice.toString() }
      : null,
    refund: t.refund
      ? { id: t.refund.id, amount: t.refund.amount.toString(), currency: t.refund.currency, status: t.refund.status }
      : null,
    dueAt: t.dueAt,
    dueAtDisplay: displayDateTime(t.dueAt),
    completedAt: t.completedAt,
    completedAtDisplay: displayDateTime(t.completedAt),
    createdAt: t.createdAt,
    createdAtDisplay: displayDateTime(t.createdAt),
  };
}

export default async function adminTasksApiRoutes(app: FastifyInstance): Promise<void> {
  // The assignee picker/filter for this page. Deliberately NOT `/api/admins`
  // (requireSuper-gated, and it also returns passwordSet/twoFa/hasSession
  // flags that must stay super-only) — this page is OPS-tier (support+super),
  // so a support admin needs a currentAdmin-gated source for the same
  // role===ADMIN identity set `assignAdminTask` validates against. No route
  // ordering concern: every other GET here is the exact literal
  // `/api/admin-tasks`, and the four param routes below are POST-only, so
  // this static GET path can never collide with them.
  app.get("/api/admin-tasks/assignees", { preHandler: currentAdmin }, async (_req, reply) => {
    const admins = await listAdminTaskAssignees(prisma);
    return reply.send({
      admins: admins.map((a) => ({
        id: a.id,
        name: a.fullName ?? a.username ?? (a.telegramId != null ? `Telegram ID ${a.telegramId}` : `Admin #${a.id}`),
      })),
    });
  });

  app.get("/api/admin-tasks", { preHandler: currentAdmin }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const page = Math.max(Number(q.page) || 1, 1);
    const requestedPageSize = Number(q.pageSize);
    const pageSize = PAGE_SIZE_OPTIONS.includes(requestedPageSize) ? requestedPageSize : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;
    const filter = buildAdminTaskFilter(q);

    // Queue-wide status counts for the KPI row — independent of the current
    // filter/page (mirrors support.ts's `getTicketStats`), so the counts
    // don't jump around as an admin narrows the list.
    const [tasks, total, pending, assigned, inProgress, escalated] = await Promise.all([
      listAdminTasks(prisma, { ...filter, limit: pageSize, offset }),
      countAdminTasks(prisma, filter),
      countAdminTasks(prisma, { status: AdminTaskStatus.PENDING }),
      countAdminTasks(prisma, { status: AdminTaskStatus.ASSIGNED }),
      countAdminTasks(prisma, { status: AdminTaskStatus.IN_PROGRESS }),
      countAdminTasks(prisma, { status: AdminTaskStatus.ESCALATED }),
    ]);

    return reply.send({
      items: tasks.map(shapeTask),
      total,
      page,
      pageSize,
      stats: { pending, assigned, inProgress, escalated },
    });
  });

  app.post("/api/admin-tasks/:taskId/assign", { preHandler: csrfProtect }, async (req, reply) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    if (!Number.isInteger(taskId)) return reply.code(400).send({ error: "Invalid task id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.from !== "string") return reply.code(400).send({ error: "from is required." });
    if (typeof body.assignedTo !== "number") return reply.code(400).send({ error: "assignedTo must be a number." });

    try {
      await assignAdminTask(prisma, {
        taskId,
        from: body.from,
        assignedTo: body.assignedTo,
        adminId: req.admin!.userId,
      });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send(errorBody(e));
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.post("/api/admin-tasks/:taskId/start", { preHandler: csrfProtect }, async (req, reply) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    if (!Number.isInteger(taskId)) return reply.code(400).send({ error: "Invalid task id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.from !== "string") return reply.code(400).send({ error: "from is required." });

    try {
      await startAdminTask(prisma, { taskId, from: body.from, adminId: req.admin!.userId });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send(errorBody(e));
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.post("/api/admin-tasks/:taskId/complete", { preHandler: csrfProtect }, async (req, reply) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    if (!Number.isInteger(taskId)) return reply.code(400).send({ error: "Invalid task id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.from !== "string") return reply.code(400).send({ error: "from is required." });

    try {
      await completeAdminTask(prisma, { taskId, from: body.from, adminId: req.admin!.userId });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send(errorBody(e));
      throw e;
    }
    return reply.send({ ok: true });
  });

  app.post("/api/admin-tasks/:taskId/escalate", { preHandler: csrfProtect }, async (req, reply) => {
    const taskId = Number((req.params as { taskId: string }).taskId);
    if (!Number.isInteger(taskId)) return reply.code(400).send({ error: "Invalid task id." });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.from !== "string") return reply.code(400).send({ error: "from is required." });

    try {
      await escalateAdminTask(prisma, { taskId, from: body.from, adminId: req.admin!.userId });
    } catch (e) {
      if (e instanceof ValidationError) return reply.code(422).send(errorBody(e));
      throw e;
    }
    return reply.send({ ok: true });
  });
}
