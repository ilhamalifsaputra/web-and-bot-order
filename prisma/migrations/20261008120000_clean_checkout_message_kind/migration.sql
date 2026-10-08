ALTER TABLE "fulfillment_messages"
  ADD COLUMN "message_kind" TEXT;

ALTER TABLE "orders"
  ADD COLUMN "credentials_delivered_at" TIMESTAMP(3),
  ADD COLUMN "credentials_doc_msg_id" INTEGER;
