-- CreateTable
CREATE TABLE "processed_telegram_updates" (
    "id" SERIAL NOT NULL,
    "update_id" BIGINT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_telegram_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_processed_telegram_update_update_id" ON "processed_telegram_updates"("update_id");

