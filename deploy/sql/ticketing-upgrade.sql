-- Safe on fresh installs and repeated starts. Prepare unique indexes BEFORE
-- db push, which otherwise asks for data-loss confirmation on populated tables.
-- Backfill activity only when adding the column: a restart must preserve newer
-- activity recorded by the application. The whole DO block is atomic.
DO $$
BEGIN
  IF to_regclass('"support_tickets"') IS NOT NULL THEN
    LOCK TABLE "support_tickets" IN SHARE ROW EXCLUSIVE MODE;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'support_tickets'
        AND column_name = 'last_activity_at'
    ) THEN
      ALTER TABLE "support_tickets"
        ADD COLUMN "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
      UPDATE "support_tickets" AS t SET "last_activity_at" = GREATEST(
        t."created_at", t."last_status_change_at", t."replied_at", t."resolved_at", t."closed_at",
        (SELECT MAX(m."created_at") FROM "ticket_messages" AS m WHERE m."ticket_id" = t."id")
      );
    END IF;
    ALTER TABLE "support_tickets" ADD COLUMN IF NOT EXISTS "request_key" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "support_tickets_user_id_request_key_key"
      ON "support_tickets" ("user_id", "request_key");
  END IF;

  IF to_regclass('"ticket_messages"') IS NOT NULL THEN
    LOCK TABLE "ticket_messages" IN SHARE ROW EXCLUSIVE MODE;
    ALTER TABLE "ticket_messages" ADD COLUMN IF NOT EXISTS "request_key" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "ticket_messages_ticket_id_sender_id_request_key_key"
      ON "ticket_messages" ("ticket_id", "sender_id", "request_key");
  END IF;
END $$;
