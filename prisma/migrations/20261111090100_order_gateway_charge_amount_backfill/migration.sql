-- Data-only migration. No schema change: it fills `orders.gateway_charge_amount`
-- for TokoPay orders created before this release, and seeds the one `settings`
-- row that bounds that backfill.
--
-- `gateway_charge_amount` is the fee-inclusive total TokoPay asked the buyer to
-- pay; every TokoPay paid-amount, overpayment and underpaid-credit check reads
-- it (`expectedTokopayCharge`). An old order left null would be checked against
-- its bare total, so its fee would show up as an overpayment and an underpaid
-- top-up credited anyway would deduct no fee. So each pre-release order gets:
--   1. the total TokoPay itself reported for it, when the old code cached that
--      in `payment_ref` (`{"gateway":"tokopay",...,"totalBayar":"50025"}`) and
--      the figure passes the same plausibility check the code applies when it
--      reads TokoPay's total (`readTokopayCharge`, packages/core/src/payments/
--      tokopayCharge.ts): plain digits, at least the nominal sent to TokoPay
--      (the order total rounded to whole rupiah), and an implied fee of at most
--      50% of that nominal plus Rp10.000. This matters for orders created after
--      TokoPay's 2026-11-11 tariff change: their QR encodes TokoPay's real total,
--      not the old formula, and IDR wallet top-ups never expire, so they can
--      still be paid after TokoPay is switched back on;
--   2. otherwise the formula the old code used (Rp100 + 0.70%, rounded half up
--      to whole rupiah). That formula was for QRIS, so orders on another TokoPay
--      channel, and orders with no usable cached total (no transaction was ever
--      created, the cache holds a claim sentinel, or the figure is malformed or
--      implausible), get it as an approximation.
-- `payment_ref` can hold non-JSON text (a gateway claim sentinel, another rail's
-- value), and Postgres does not promise that `AND` evaluates left to right, so
-- the JSON cast sits inside a CASE guarded by `IS JSON OBJECT` (PostgreSQL 16+,
-- the version this project deploys) and can never raise on such a value.
--
-- One-shot by cutoff. docker-entrypoint.sh re-runs this file on EVERY start, but
-- an order created after this release can legitimately have no charge yet (a
-- storefront order between checkout and its first pay-page load); stamping the
-- old formula on it would flag a correct payment as UNDERPAID. So the first run
-- records its own time as `tokopay_gateway_charge_backfill_cutoff` (same
-- pattern as 20261008120100_backfill_credentials_delivered_at: `NOW()` is the
-- deploy of this release, `ON CONFLICT DO NOTHING` keeps the first value), and
-- only orders created BEFORE that cutoff are ever backfilled. Orders created
-- after it get their charge from TokoPay's own response when the transaction is
-- created. The key is internal: it is not in the admin Settings page's EDITABLE
-- list, so the Settings page and the settings export never show it. The cutoff
-- is read back in the same statement (the inserted row through RETURNING, an
-- existing row from the table) so the file stays one statement.
--
-- Safe to re-run: the cutoff never moves after the first run, so a re-run can
-- only reach orders created before it; and the WHERE clause only touches rows
-- whose `gateway_charge_amount` IS NULL, so an order that already has a charge
-- (from this file or from TokoPay's response) keeps it. A second run updates
-- nothing.
WITH inserted AS (
  INSERT INTO "settings" ("key", "value", "updated_at")
  VALUES ('tokopay_gateway_charge_backfill_cutoff', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NOW())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "value"
),
cutoff AS (
  SELECT "value"::timestamp(3) AS "at" FROM inserted
  UNION ALL
  SELECT "value"::timestamp(3) FROM "settings" WHERE "key" = 'tokopay_gateway_charge_backfill_cutoff'
),
cached AS (
  -- TokoPay's own total from the cached gateway response, or NULL. Each cast
  -- runs only inside the CASE branch whose condition proved it safe.
  SELECT c."id",
    CASE WHEN c."ref_text" ~ '^[0-9]+$' THEN c."ref_text"::numeric END AS "charge"
  FROM (
    SELECT x."id",
      CASE WHEN x."payment_ref" IS JSON OBJECT THEN
        CASE WHEN (x."payment_ref"::json ->> 'gateway') = 'tokopay'
          THEN btrim(x."payment_ref"::json ->> 'totalBayar')
        END
      END AS "ref_text"
    FROM "orders" AS x
    WHERE x."payment_method" = 'TOKOPAY'
      AND x."currency" = 'IDR'
      AND x."gateway_charge_amount" IS NULL
  ) AS c
)
UPDATE "orders" AS o
SET "gateway_charge_amount" = CASE
    WHEN k."charge" >= ROUND(o."total_amount")
     AND k."charge" - ROUND(o."total_amount") <= ROUND(o."total_amount") * 0.5 + 10000
      THEN k."charge"
    ELSE o."total_amount" + ROUND(100 + o."total_amount" * 0.007)
  END
FROM cached AS k
WHERE k."id" = o."id"
  AND o."payment_method" = 'TOKOPAY'
  AND o."currency" = 'IDR'
  AND o."gateway_charge_amount" IS NULL
  AND o."created_at" < (SELECT MIN("at") FROM cutoff);
