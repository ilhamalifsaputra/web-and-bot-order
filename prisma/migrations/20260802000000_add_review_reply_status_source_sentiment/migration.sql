-- Turns the admin Reviews page into a Customer Feedback Management dashboard
-- (Task 1 of the reviews-module refactor). Reconciles the spec's two status
-- vocabularies into three orthogonal fields rather than collapsing them into
-- one enum:
--   * visibility  — existing `hidden` boolean, untouched (published/hidden).
--   * status      — NEW reply-workflow state: PENDING_REPLY | REPLIED |
--                    CLOSED (spec §11's set). Independent of `hidden`, so an
--                    admin can hide a review without it counting as "replied".
--   * source      — NEW provenance: CUSTOMER | SYSTEM_AUTO. Every existing
--                    and Phase-A row is CUSTOMER; SYSTEM_AUTO is reserved so
--                    the deferred auto-review job (Phase B) needs no further
--                    migration.
--   * sentiment   — NEW: POSITIVE | NEUTRAL | NEGATIVE, computed once and
--                    persisted (not derived on read) so it stays filterable/
--                    aggregatable from the dashboard.
--
-- status/source/sentiment use `NOT NULL DEFAULT '<literal>'` — SQLite's
-- `ALTER TABLE ADD COLUMN` accepts a constant literal default (confirmed
-- against the existing 20260531140000_review_hidden and
-- 20260725000000_add_ticket_priority_category_resolved migrations), so this
-- is a plain ADD COLUMN, no table rebuild needed.
--
-- The three new reply-content columns (admin_reply, replied_at,
-- replied_by_admin_id) mirror support_tickets' admin_reply/replied_at/
-- admin_id trio for convention consistency, and are added nullable with no
-- default (also a plain ADD COLUMN — nullable-no-default never triggers
-- SQLite's non-constant-default restriction). replied_by_admin_id has no FK
-- constraint at the SQLite level (same as support_tickets.admin_id before
-- its own rebuild) — Prisma's `repliedByAdmin` relation is enforced at the
-- application layer only, which is how the existing SupportTicket.admin
-- relation already works on this table shape.
--
-- The default of 'NEUTRAL' on the new sentiment column is only a
-- placeholder for the ADD COLUMN statement itself; every pre-existing row
-- gets real classification immediately below, backfilled from its rating
-- (>=4 POSITIVE, <=2 NEGATIVE, else NEUTRAL) so historical reviews are
-- immediately usable by the dashboard's sentiment filter/aggregates instead
-- of all bucketing into NEUTRAL until re-touched.
ALTER TABLE "reviews" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING_REPLY';
ALTER TABLE "reviews" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'CUSTOMER';
ALTER TABLE "reviews" ADD COLUMN "sentiment" TEXT NOT NULL DEFAULT 'NEUTRAL';
ALTER TABLE "reviews" ADD COLUMN "admin_reply" TEXT;
ALTER TABLE "reviews" ADD COLUMN "replied_at" DATETIME;
ALTER TABLE "reviews" ADD COLUMN "replied_by_admin_id" INTEGER;

UPDATE "reviews" SET "sentiment" = 'POSITIVE' WHERE "rating" >= 4;
UPDATE "reviews" SET "sentiment" = 'NEGATIVE' WHERE "rating" <= 2;
-- rating = 3 rows keep the column default of 'NEUTRAL' set above.

CREATE INDEX "ix_reviews_status" ON "reviews"("status");
