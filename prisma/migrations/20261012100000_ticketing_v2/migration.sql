-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "legal_hold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'WEB',
ADD COLUMN     "request_key" TEXT,
ADD COLUMN     "subcategory" TEXT;

-- AlterTable
ALTER TABLE "ticket_messages" ADD COLUMN     "origin" TEXT NOT NULL DEFAULT 'WEB',
ADD COLUMN     "request_key" TEXT;

-- CreateTable
CREATE TABLE "support_attachments" (
    "id" TEXT NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "draft_id" TEXT NOT NULL,
    "ticket_id" INTEGER,
    "message_id" INTEGER,
    "bucket" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "etag" TEXT,
    "telegram_bot_id" TEXT,
    "telegram_file_id" TEXT,
    "attached_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "support_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_attachments_storage_key_key" ON "support_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "support_attachments_owner_id_draft_id_idx" ON "support_attachments"("owner_id", "draft_id");

-- CreateIndex
CREATE INDEX "support_attachments_status_expires_at_idx" ON "support_attachments"("status", "expires_at");

-- CreateIndex
CREATE INDEX "support_tickets_last_activity_at_idx" ON "support_tickets"("last_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_user_id_request_key_key" ON "support_tickets"("user_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_messages_ticket_id_sender_id_request_key_key" ON "ticket_messages"("ticket_id", "sender_id", "request_key");

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachments" ADD CONSTRAINT "support_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "ticket_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve historical activity order; migration time is not ticket activity.
UPDATE "support_tickets" AS t SET "last_activity_at" = GREATEST(
  t."created_at", t."last_status_change_at", t."replied_at", t."resolved_at", t."closed_at",
  (SELECT MAX(m."created_at") FROM "ticket_messages" AS m WHERE m."ticket_id" = t."id")
);
