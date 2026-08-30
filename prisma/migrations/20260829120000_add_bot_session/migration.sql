-- CreateTable
CREATE TABLE "bot_sessions" (
    "key" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bot_sessions_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ix_bot_session_expires_at" ON "bot_sessions"("expires_at");

