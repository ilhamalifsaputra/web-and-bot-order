-- Task E5 item 1: give notification_outbox an optional idempotency key.
--
-- Generated with `prisma migrate diff --from-migrations ./prisma/migrations
-- --to-schema-datamodel ./prisma/schema.prisma --script` and committed
-- verbatim, so `pnpm run check-migration-drift` stays green (docs/MIGRATIONS.md).
--
-- SAFETY: purely additive. `ALTER TABLE ... ADD COLUMN` of a NULLable column
-- with no default, plus a new index — no SQLite table rebuild, no data
-- movement, nothing dropped. Every existing row gets dedupe_key = NULL, and
-- NULLs are distinct in a SQLite UNIQUE index, so no existing row can collide
-- with another and the constraint is unfalsifiable against current data.
--
-- DEPLOY: apply to the live DB with `pnpm exec prisma db push` (this repo's
-- actual mechanism — `migrate deploy` is NOT used, see docs/MIGRATIONS.md),
-- and restart order-bot, BOTH before the code that writes dedupe_key runs, or
-- the first enqueue throws `P2022 column dedupe_key does not exist`. This file
-- is the audit trail for that change, not the thing that applies it.

-- AlterTable
ALTER TABLE "notification_outbox" ADD COLUMN "dedupe_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ix_notification_outbox_dedupe_key" ON "notification_outbox"("dedupe_key");
