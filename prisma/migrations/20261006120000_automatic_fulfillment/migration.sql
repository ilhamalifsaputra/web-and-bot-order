ALTER TABLE "orders" ADD COLUMN "fulfillment_provider" TEXT,
  ADD COLUMN "fulfillment_sku" TEXT;

CREATE INDEX "ix_orders_fulfillment_provider_status" ON "orders"("fulfillment_provider", "status");

CREATE TABLE "fulfillment_messages" (
  "order_id" INTEGER NOT NULL,
  "chat_id" BIGINT NOT NULL,
  "message_id" INTEGER,
  "state" TEXT NOT NULL DEFAULT 'READY',
  "claimed_at" TIMESTAMP(3),
  "next_update_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_text" TEXT,
  "finished_at" TIMESTAMP(3),
  CONSTRAINT "fulfillment_messages_pkey" PRIMARY KEY ("order_id"),
  CONSTRAINT "fulfillment_messages_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "ix_fulfillment_messages_due" ON "fulfillment_messages"("state", "next_update_at");
