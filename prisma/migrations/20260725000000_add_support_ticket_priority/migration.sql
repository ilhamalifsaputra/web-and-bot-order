-- Add priority column to SupportTicket model for ticket prioritization
ALTER TABLE "support_tickets" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'MEDIUM';

CREATE INDEX "ix_support_tickets_priority" ON "support_tickets"("priority");
