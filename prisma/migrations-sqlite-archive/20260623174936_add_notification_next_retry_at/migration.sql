-- AlterTable
ALTER TABLE "notification_outbox" ADD COLUMN "next_retry_at" DATETIME;
