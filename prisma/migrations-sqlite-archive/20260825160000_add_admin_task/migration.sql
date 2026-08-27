-- Task 9a (Trustance Master Architecture, §38 Admin Task Queue): the
-- `admin_tasks` table — schema AND crud land together in this task (unlike
-- the Refund domain, split into a schema-only task then a crud task). Pure
-- additive CREATE TABLE + indexes, hand-written per docs/MIGRATIONS.md (this
-- repo deploys schema with `prisma db push`, so these files are the SQL
-- audit trail, verified byte-identical to `prisma migrate diff --script`
-- output by `pnpm run check-migration-drift` in `pretest`). Never touches an
-- existing table — safe on a live DB with no backfill step.
--
-- `admin_tasks.order_id` -> `orders.id`, `admin_tasks.order_item_id` ->
-- `order_items.id`, and `admin_tasks.refund_id` -> `refunds.id` are all ON
-- DELETE RESTRICT, matching this schema's existing conservative FK policy
-- for every other Order-adjacent financial/operational-audit row
-- (wallet_transactions, order_status_history, refunds, refund_items —
-- Infra-5 fix, security audit 2026-06-23): no code path hard-deletes an
-- Order/OrderItem/Refund today; this is a schema-level guardrail against
-- ever adding one that would silently orphan a task record. All three FKs
-- are nullable — an AdminTask can reference a whole order, a specific line
-- within it, a specific Refund under review, any combination of the three,
-- or (for a task type that needs no order context) none at all, mirroring
-- SupportTicket's existing optional orderId shape.
--
-- `admin_tasks.assigned_to` -> `users.id` is ON DELETE NO ACTION instead —
-- matches `support_tickets.admin_id` and `audit_logs.admin_id`'s existing
-- "acting admin" FK policy, not the Restrict policy used for the three
-- reference FKs above (assignedTo is only "who is currently working this",
-- not the audit-significant row the task is ABOUT).
--
-- `admin_tasks.priority` defaults 'MEDIUM' (LOW | MEDIUM | HIGH | URGENT,
-- same vocabulary as support_tickets.priority) and `admin_tasks.status`
-- defaults 'PENDING' (PENDING | ASSIGNED | IN_PROGRESS | ESCALATED |
-- COMPLETED) — both safe as NOT NULL DEFAULT because this is a brand new,
-- currently-empty table (unlike the nullable-no-default pattern used for
-- retrofitting a column onto an already-populated table, e.g.
-- order_items.status in 20260825140000_add_order_item_status).
--
-- See schema.prisma's doc comment on AdminTask for the full design
-- reasoning (why refund_id was added beyond the master-architecture field
-- list verbatim, the assign/start/complete/escalate state machine, and how
-- this table relates to the separate, read-only `GET /api/dashboard/
-- operations` counters).

-- CreateTable
CREATE TABLE "admin_tasks" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL,
    "order_id" INTEGER,
    "order_item_id" INTEGER,
    "refund_id" INTEGER,
    "assigned_to" INTEGER,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "due_at" DATETIME,
    "completed_at" DATETIME,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    CONSTRAINT "admin_tasks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "admin_tasks_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "order_items" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "admin_tasks_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "admin_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "ix_admin_tasks_status" ON "admin_tasks"("status");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_type" ON "admin_tasks"("type");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_assigned_to" ON "admin_tasks"("assigned_to");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_order_id" ON "admin_tasks"("order_id");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_order_item_id" ON "admin_tasks"("order_item_id");

-- CreateIndex
CREATE INDEX "ix_admin_tasks_refund_id" ON "admin_tasks"("refund_id");
