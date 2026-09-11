-- CreateTable
CREATE TABLE "qris_underpaid_tx" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "gateway" TEXT NOT NULL,
    "received_amount" DECIMAL(65,30) NOT NULL,
    "expected_amount" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qris_underpaid_tx_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qris_underpaid_tx_order_id_key" ON "qris_underpaid_tx"("order_id");
