-- Admin triage/SLA fields for the operational ticket queue: category,
-- first-response timestamp, resolved timestamp, and a last-status-change
-- timestamp the overdue calc reads instead of createdAt (so a reopened
-- ticket's wait clock resets correctly). `priority` and its index are NOT
-- added here — 20260725000000_add_support_ticket_priority (an independently
-- merged branch) already added both; redoing them here would fail with a
-- duplicate-column/duplicate-index error on any DB that ran that migration.
--
-- Added as simple ADD COLUMN statements (same low-risk pattern as the
-- order_id column in 20260724150000_add_support_ticket_order_link) rather
-- than a full table rebuild: support_tickets carries live production data,
-- and none of these columns require anything a rebuild would provide.
--
-- last_status_change_at is added nullable, not `NOT NULL DEFAULT
-- CURRENT_TIMESTAMP` (SQLite's ALTER TABLE ADD COLUMN rejects any default
-- that isn't a constant — CURRENT_TIMESTAMP doesn't qualify, so that form
-- fails with "Cannot add a column with non-constant default" at migrate
-- time; `prisma db push`, used by the test suite, sidesteps this via a full
-- table rebuild instead of ALTER TABLE, which is why the bug only surfaced
-- on a real `migrate deploy`). Backfilled from created_at immediately below
-- so every existing row still gets a sane value; every code path that
-- writes this column going forward (createTicket via schema.prisma's
-- `@default(now())`, closeTicket/resolveTicket/reopenTicketAdmin) sets it
-- explicitly, so it is never actually null in practice despite the column
-- itself not enforcing NOT NULL at the SQLite level.
ALTER TABLE "support_tickets" ADD COLUMN "category" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "first_response_at" DATETIME;
ALTER TABLE "support_tickets" ADD COLUMN "resolved_at" DATETIME;
ALTER TABLE "support_tickets" ADD COLUMN "last_status_change_at" DATETIME;
UPDATE "support_tickets" SET "last_status_change_at" = "created_at" WHERE "last_status_change_at" IS NULL;

CREATE INDEX "ix_support_tickets_status" ON "support_tickets"("status");
