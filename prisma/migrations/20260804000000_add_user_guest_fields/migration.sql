-- Task 1 of guest checkout: `Order.userId` is a required non-null FK, so a
-- guest shopper (no login) still needs a real `User` row to attach the order
-- to. These two columns mark that row as synthetic and carry the contact
-- email the guest typed at checkout.
--
-- Plain ADD COLUMN (not a table rebuild): neither column adds a foreign key
-- or a new unique constraint, and SQLite's ADD COLUMN allows both a NOT NULL
-- column with a constant default (is_guest) and a nullable column with no
-- default (guest_email) — see prisma/migrations/20260721120000_add_product_archived
-- for the same pattern. `guest_email` is deliberately NOT unique/indexed
-- unique: the same guest email may be used across many checkout sessions.
ALTER TABLE "users" ADD COLUMN "is_guest" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "guest_email" TEXT;
