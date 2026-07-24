-- Admin triage/SLA fields for the operational ticket queue: priority,
-- category, first-response timestamp, resolved timestamp, and a
-- last-status-change timestamp the overdue calc reads instead of
-- createdAt (so a reopened ticket's wait clock resets correctly).
--
-- Added as simple ADD COLUMN statements (same low-risk pattern as the
-- order_id column in 20260724150000_add_support_ticket_order_link) rather
-- than a full table rebuild: support_tickets carries live production data,
-- and none of these columns require anything a rebuild would provide.
ALTER TABLE "support_tickets" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'MEDIUM';
ALTER TABLE "support_tickets" ADD COLUMN "category" TEXT;
ALTER TABLE "support_tickets" ADD COLUMN "first_response_at" DATETIME;
ALTER TABLE "support_tickets" ADD COLUMN "resolved_at" DATETIME;
ALTER TABLE "support_tickets" ADD COLUMN "last_status_change_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "ix_support_tickets_status" ON "support_tickets"("status");
CREATE INDEX "ix_support_tickets_priority" ON "support_tickets"("priority");
