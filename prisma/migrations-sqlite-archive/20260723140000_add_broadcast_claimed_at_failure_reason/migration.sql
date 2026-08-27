-- Support FAILED broadcasts: claimed_at lets a reaper detect a SENDING row
-- whose drainer crashed mid-loop (mirrors notification_outbox.claimed_at /
-- STALE_CLAIM_MS in packages/db/src/crud/notifications.ts); failure_reason
-- is a short human-readable string shown in the admin History table.
-- Apply in dev with `pnpm prisma db push`.
ALTER TABLE "broadcasts" ADD COLUMN "claimed_at" DATETIME;
ALTER TABLE "broadcasts" ADD COLUMN "failure_reason" TEXT;
