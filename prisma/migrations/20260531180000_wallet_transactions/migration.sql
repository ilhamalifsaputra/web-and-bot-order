-- Wallet ledger: an append-only per-user money timeline written by
-- adjustWallet, so every balance movement (manual top-up, refund, referral
-- payout, order payment/refund) is recorded with a running balance. Apply in
-- dev with `pnpm prisma db push`; this file is the reproducible delta.

CREATE TABLE "wallet_transactions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "delta" DECIMAL NOT NULL,
    "balance_after" DECIMAL NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "admin_id" INTEGER,
    "order_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "ix_wallet_transactions_user_id" ON "wallet_transactions"("user_id");
