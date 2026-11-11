-- Freeze every existing TokoPay order at the fee formula that was in force when
-- it was created (Rp100 + 0.70%, rounded half up to whole rupiah), so replacing
-- that formula in code does not change how past overpaid/underpaid orders are
-- evaluated. Idempotent: only rows without a stored figure are touched.
UPDATE "orders"
SET "gateway_charge_amount" = "total_amount" + ROUND(100 + "total_amount" * 0.007)
WHERE "payment_method" = 'TOKOPAY'
  AND "currency" = 'IDR'
  AND "gateway_charge_amount" IS NULL;
