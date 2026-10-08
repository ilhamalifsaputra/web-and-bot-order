-- Data-only migration. No schema change: it backfills
-- `orders.credentials_delivered_at` for stock orders delivered before the
-- column existed.
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
-- Safe to re-run: the WHERE clause only touches rows whose
-- `credentials_delivered_at` IS NULL, so an order already recorded (by this
-- file or by the bot) keeps its value, and a second run updates nothing.
UPDATE "orders" AS o
SET "credentials_delivered_at" = COALESCE(o."delivered_at", o."paid_at", o."created_at")
WHERE o."credentials_delivered_at" IS NULL
  AND UPPER(o."status") = 'DELIVERED'
  AND o."kind" = 'PRODUCT'
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
