-- Soft-hide for a Product (mid-tier), independent of isActive: an archived
-- product drops out of the admin's default catalog list and out of every
-- customer-facing surface, but keeps its data (denominations, order history)
-- intact — unlike a hard Delete, which is refused once it has denominations.

ALTER TABLE "products" ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false;
