-- Data-only migration. No schema change: it backfills
-- `orders.credentials_delivered_at` for stock orders delivered before the
-- column existed, and seeds the one `settings` row that bounds that backfill.
--
-- The column records that Telegram acknowledged an order's credentials `.txt`
-- document. Automatic senders skip the document once it is set, and the
-- progress message's delivery phase waits for it. A stock order delivered
-- before this release already received its credentials the old way, so leaving
-- the column null would let an automatic sender treat it as undelivered and
-- send the file again (or keep its progress message waiting for a file that is
-- never coming). The document's Telegram message id is not known for these
-- orders, so `credentials_doc_msg_id` stays null.
--
-- One-shot by cutoff. docker-entrypoint.sh re-runs this file on EVERY start,
-- but a stock order is committed DELIVERED before its file is sent (wallet
-- completion sends after commit; the outbox ORDER_DELIVERED_DM retries). An
-- unbounded backfill would therefore, on any later restart, stamp orders whose
-- file never arrived, and the bot would stop retrying and call them complete.
-- So the first run records its own time as `credentials_delivered_backfill_cutoff`
-- (same precedent as 20260919120000_seed_usdt_rounding_ceil_since: `NOW()` is the
-- deploy of this release, `ON CONFLICT DO NOTHING` keeps the first value), and
-- only orders delivered BEFORE that cutoff are ever backfilled. Orders delivered
-- after it are recorded by the bot itself when Telegram acknowledges the file.
-- The cutoff is read back in the same statement (the inserted row through
-- RETURNING, an existing row from the table) so the file stays one statement.
-- Deploy window: during a rolling deploy the dispatcher is down while the bot
-- keeps delivering stock orders and queueing their ORDER_DELIVERED_DM, all
-- before this first run's cutoff. Stamping those orders would make the new
-- dispatcher record the queued DM as sent without sending the file (it skips
-- automatic DMs once `credentials_delivered_at` is set), and the same would
-- swallow an admin resend queued before the deploy and a FAILED DM an admin
-- retries later. So an order with any ORDER_DELIVERED_DM row not yet SENT
-- (matched on the outbox's `order_id` column, which every enqueue path sets)
-- is left null: the dispatcher sends its file and the bot records it. Known
-- edge: a file whose old-code direct send was in flight at the first run, with
-- no outbox row, is treated as delivered; old-code deliveries were never
-- tracked anyway.
--
-- "Stock order" is resolved exactly as `fulfillmentProviderFor`
-- (packages/core/src/orderFulfillment.ts) does: the frozen
-- `fulfillment_provider` when it is DIGIFLAZZ/MANUAL/STOCK; otherwise (legacy
-- rows) not stock when any line's denomination is Digiflazz-sourced or any
-- line's delivery type (snapshot, else live denomination) is not "auto".
-- Wallet top-ups carry no credentials and are left alone.
--
-- The timestamp is the order's own `delivered_at`, falling back to `paid_at`
-- and then `created_at` so the column is never left null for a delivered order.
--
-- Safe to re-run: the cutoff never moves after the first run, so a re-run can
-- only reach orders delivered before it; and the WHERE clause only touches rows
-- whose `credentials_delivered_at` IS NULL, so an order already recorded (by
-- this file or by the bot) keeps its value. A second run updates nothing.
WITH inserted AS (
  INSERT INTO "settings" ("key", "value", "updated_at")
  VALUES ('credentials_delivered_backfill_cutoff', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), NOW())
  ON CONFLICT ("key") DO NOTHING
  RETURNING "value"
),
cutoff AS (
  SELECT "value"::timestamp(3) AS "at" FROM inserted
  UNION ALL
  SELECT "value"::timestamp(3) FROM "settings" WHERE "key" = 'credentials_delivered_backfill_cutoff'
)
UPDATE "orders" AS o
SET "credentials_delivered_at" = COALESCE(o."delivered_at", o."paid_at", o."created_at")
WHERE o."credentials_delivered_at" IS NULL
  AND UPPER(o."status") = 'DELIVERED'
  AND o."kind" = 'PRODUCT'
  AND COALESCE(o."delivered_at", o."paid_at", o."created_at") < (SELECT MIN("at") FROM cutoff)
  AND NOT EXISTS (
    SELECT 1
    FROM "notification_outbox" AS n
    WHERE n."order_id" = o."id"
      AND n."event" = 'ORDER_DELIVERED_DM'
      AND n."status" <> 'SENT'
  )
  AND (
    o."fulfillment_provider" = 'STOCK'
    OR (
      COALESCE(o."fulfillment_provider", '') NOT IN ('DIGIFLAZZ', 'MANUAL', 'STOCK')
      AND NOT EXISTS (
        SELECT 1
        FROM "order_items" AS i
        JOIN "denominations" AS d ON d."id" = i."product_id"
        WHERE i."order_id" = o."id"
          AND (
            d."auto_delivery_source" = 'digiflazz'
            OR COALESCE(i."delivery_type_snapshot", d."delivery_type") <> 'auto'
          )
      )
    )
  );
