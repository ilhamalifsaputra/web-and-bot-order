-- Trustance Phase C Task 1 — ticketing upgrades: ticketNumber, assignment
-- audit trail (assignedAt/assignedBy), and TicketMessage.internal.
-- Generated via:
--   npx prisma migrate diff --from-migrations prisma/migrations \
--     --to-schema-datamodel prisma/schema.prisma \
--     --shadow-database-url <scratch db on the same Postgres instance> --script
--
-- ticket_number/assigned_at/assigned_by are added nullable, no default —
-- `prisma db push`/this migration never backfills existing rows (see
-- SupportTicket.ticketNumber's schema doc comment). `internal` is NOT NULL
-- DEFAULT false, which is safe to add straight (unlike a nullable-no-default
-- column) because every existing TicketMessage row is unambiguously a
-- customer-visible message — there is no legacy "unknown internal-ness" case
-- to preserve as null, so a hard default is the correct backfill, not a data
-- loss risk.

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "assigned_at" TIMESTAMP(3),
ADD COLUMN     "assigned_by" INTEGER,
ADD COLUMN     "ticket_number" TEXT;

-- AlterTable
ALTER TABLE "ticket_messages" ADD COLUMN     "internal" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_ticket_number_key" ON "support_tickets"("ticket_number");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
