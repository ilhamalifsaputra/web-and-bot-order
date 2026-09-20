-- Index every foreign-key column on the Financial Ledger tables. Postgres
-- indexes the referenced (parent) side of a FK automatically but never the
-- referencing (child) side, so each of these columns was previously read — and,
-- worse, checked on every `ON DELETE RESTRICT` of the parent row — by a
-- sequential scan of the child table. These five were the ones the M13/M18
-- migrations missed; the rest of the schema already follows the
-- index-every-FK-column convention.

-- CreateIndex
CREATE INDEX "ix_financial_tx_reversal_of" ON "financial_transactions"("reversal_of_id");

-- CreateIndex
CREATE INDEX "ix_settlement_tx_payment_id" ON "settlement_transactions"("payment_id");

-- CreateIndex
CREATE INDEX "ix_stock_replacements_replacement_stock" ON "stock_replacements"("replacement_stock_item_id");

-- CreateIndex
CREATE INDEX "ix_stock_replacements_refund" ON "stock_replacements"("refund_id");

-- CreateIndex
CREATE INDEX "ix_stock_replacements_support_ticket" ON "stock_replacements"("support_ticket_id");
