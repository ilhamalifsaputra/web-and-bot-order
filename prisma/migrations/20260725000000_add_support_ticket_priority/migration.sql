-- Add priority column to SupportTicket model for ticket prioritization
ALTER TABLE "support_tickets" ADD COLUMN "priority" TEXT NOT NULL DEFAULT 'MEDIUM';
