-- Broadcast queue: the web admin enqueues a segmented broadcast here and the
-- order-bot drains it (the web never calls Telegram). Apply in dev with
-- `pnpm prisma db push`; this file is the reproducible delta.

CREATE TABLE "broadcasts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "message" TEXT NOT NULL,
    "segment" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduled_at" DATETIME,
    "created_by_id" INTEGER,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" DATETIME
);
CREATE INDEX "ix_broadcasts_status" ON "broadcasts"("status");
