-- The fee-inclusive amount the payment gateway said the buyer must pay.
ALTER TABLE "orders" ADD COLUMN "gateway_charge_amount" DECIMAL(65,30);
