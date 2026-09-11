-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_body" TEXT NOT NULL,
    "status_code" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_idempotency_record_key_endpoint" ON "idempotency_records"("key", "endpoint");
