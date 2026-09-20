-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "fee" DECIMAL(65,30),
ADD COLUMN     "net_amount" DECIMAL(65,30),
ADD COLUMN     "provider_transaction_id" TEXT;

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "financial_transactions" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" INTEGER NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversal_of_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "financial_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" SERIAL NOT NULL,
    "financial_transaction_id" INTEGER NOT NULL,
    "account_id" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_executions" (
    "id" SERIAL NOT NULL,
    "refund_id" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "proof_file_id" TEXT,
    "executed_by" INTEGER NOT NULL,
    "executed_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlements" (
    "id" SERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "batch_reference" TEXT,
    "settlement_date" TIMESTAMP(3) NOT NULL,
    "currency" TEXT NOT NULL,
    "gross_amount" DECIMAL(65,30) NOT NULL,
    "fee_amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(65,30) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECORDED',
    "created_by" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_transactions" (
    "id" SERIAL NOT NULL,
    "settlement_id" INTEGER NOT NULL,
    "payment_id" INTEGER,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL,
    "matched_at" TIMESTAMP(3),

    CONSTRAINT "settlement_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_ledger_accounts_code" ON "ledger_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ix_financial_tx_idempotency_key" ON "financial_transactions"("idempotency_key");

-- CreateIndex
CREATE INDEX "ix_financial_tx_reference" ON "financial_transactions"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "ix_financial_tx_type_occurred" ON "financial_transactions"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "ix_ledger_entries_ft" ON "ledger_entries"("financial_transaction_id");

-- CreateIndex
CREATE INDEX "ix_ledger_entries_account" ON "ledger_entries"("account_id");

-- CreateIndex
CREATE INDEX "ix_refund_executions_refund_id" ON "refund_executions"("refund_id");

-- CreateIndex
CREATE INDEX "ix_settlements_provider_date" ON "settlements"("provider", "settlement_date");

-- CreateIndex
CREATE INDEX "ix_settlement_tx_settlement_id" ON "settlement_transactions"("settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "ix_payments_method_provider_txn" ON "payments"("method", "provider_transaction_id");

-- AddForeignKey
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_financial_transaction_id_fkey" FOREIGN KEY ("financial_transaction_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "refund_executions" ADD CONSTRAINT "refund_executions_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "settlement_transactions" ADD CONSTRAINT "settlement_transactions_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "settlement_transactions" ADD CONSTRAINT "settlement_transactions_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

