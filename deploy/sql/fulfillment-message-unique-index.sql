-- Safe to repeat before db push. On a fresh database db push creates the table
-- and index itself. Existing rows are never changed or deleted here.
DO $$
BEGIN
  IF to_regclass('"fulfillment_messages"') IS NOT NULL THEN
    -- Prevent concurrent writes between the duplicate check and index creation.
    LOCK TABLE "fulfillment_messages" IN SHARE MODE;
    IF EXISTS (
      SELECT 1 FROM "fulfillment_messages"
      WHERE "chat_id" IS NOT NULL AND "message_id" IS NOT NULL
      GROUP BY "chat_id", "message_id" HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION 'fulfillment_messages contains duplicate (chat_id, message_id) pairs; inspect and resolve them before restarting. No rows were changed.';
    END IF;
    CREATE UNIQUE INDEX IF NOT EXISTS "ix_fulfillment_messages_chat_message"
      ON "fulfillment_messages" ("chat_id", "message_id");
  END IF;
END $$;
