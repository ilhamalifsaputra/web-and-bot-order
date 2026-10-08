ALTER TABLE "orders"
  ADD COLUMN "payment_state" TEXT,
  ADD COLUMN "wallet_credit_state" TEXT,
  ADD COLUMN "completion_mode" TEXT,
  ADD COLUMN "completed_by" INTEGER,
  ADD COLUMN "completed_at" TIMESTAMP(3),
  ADD COLUMN "completion_reason" TEXT;

CREATE UNIQUE INDEX "ix_fulfillment_messages_chat_message"
  ON "fulfillment_messages"("chat_id", "message_id");
