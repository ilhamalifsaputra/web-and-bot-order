-- Optional link from a support ticket to the order it's about (customer-
-- picked at creation time) — unlocks the storefront ticket page's Order/
-- Product Summary sidebar. Null for general-purpose tickets.
ALTER TABLE "support_tickets" ADD COLUMN "order_id" INTEGER;

CREATE INDEX "ix_support_tickets_order_id" ON "support_tickets"("order_id");
