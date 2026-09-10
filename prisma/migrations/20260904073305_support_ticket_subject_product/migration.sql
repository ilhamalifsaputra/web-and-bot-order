-- Add SupportTicket.subject (short customer title) and SupportTicket.product_id
-- (optional catalog Product link), both for the new storefront /help create
-- form. Both nullable, no default, no backfill — historical rows keep NULL
-- (subject: storefront falls back to message's first line; product_id: no
-- product association). Mirrors the nullable-no-default pattern used for
-- ticket_number/assigned_at/assigned_by in 20260828174533_ticket_upgrades.

-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "subject" TEXT,
ADD COLUMN     "product_id" INTEGER;

-- CreateIndex
CREATE INDEX "ix_support_tickets_product_id" ON "support_tickets"("product_id");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
