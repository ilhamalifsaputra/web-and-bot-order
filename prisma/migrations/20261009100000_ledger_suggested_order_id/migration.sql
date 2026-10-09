-- Display-only hint: the order a gateway payment was probably meant for when the
-- callback could not settle it (short-paid, unverified amount, wrong
-- method/currency). Never read by money, reclaim, credit or settle logic;
-- order_id stays the only link that means "this payment settled that order".
ALTER TABLE "processed_binance_tx" ADD COLUMN "suggested_order_id" INTEGER;
ALTER TABLE "processed_bybit_tx" ADD COLUMN "suggested_order_id" INTEGER;
ALTER TABLE "processed_tokopay_tx" ADD COLUMN "suggested_order_id" INTEGER;
ALTER TABLE "processed_paydisini_tx" ADD COLUMN "suggested_order_id" INTEGER;
ALTER TABLE "processed_nowpayments_tx" ADD COLUMN "suggested_order_id" INTEGER;
