-- Per-SKU opt-in: when true, adding stock to this denomination broadcasts a
-- "back in stock" DM to every non-banned customer with a linked Telegram
-- account (not just RestockSubscription opt-ins).

ALTER TABLE "denominations" ADD COLUMN "broadcast_on_restock" BOOLEAN NOT NULL DEFAULT false;
