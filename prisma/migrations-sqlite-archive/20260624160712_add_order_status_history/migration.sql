-- AlterTable
ALTER TABLE "orders" ADD COLUMN "confirmations" INTEGER;
ALTER TABLE "orders" ADD COLUMN "confirmed_at" DATETIME;
ALTER TABLE "orders" ADD COLUMN "first_detected_at" DATETIME;
ALTER TABLE "orders" ADD COLUMN "network" TEXT;
ALTER TABLE "orders" ADD COLUMN "required_confirmations" INTEGER;

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "occurred_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" TEXT,
    CONSTRAINT "order_status_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- CreateIndex
CREATE INDEX "ix_order_status_history_order_occurred" ON "order_status_history"("order_id", "occurred_at");
