-- Task B2 (backend audit): lets a crash-stuck "matched" idempotency claim be
-- told apart from an in-flight one. Additive with a default, so existing rows
-- read as "last touched now" and only become reclaimable after the window.
ALTER TABLE "processed_binance_tx" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "processed_bybit_tx" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "processed_tokopay_tx" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "processed_paydisini_tx" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "processed_nowpayments_tx" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
