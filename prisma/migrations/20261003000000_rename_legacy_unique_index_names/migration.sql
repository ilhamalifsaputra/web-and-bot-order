-- Rename the unique indexes inherited from the SQLite era to the names Prisma
-- derives by default, so the schema no longer needs `map:` overrides for them.
ALTER INDEX "sqlite_autoindex_categories_1" RENAME TO "categories_name_key";
ALTER INDEX "sqlite_autoindex_reviews_1" RENAME TO "reviews_user_id_order_id_key";
ALTER INDEX "sqlite_autoindex_referrals_1" RENAME TO "referrals_referee_id_key";
ALTER INDEX "sqlite_autoindex_restock_subscriptions_1" RENAME TO "restock_subscriptions_user_id_product_id_key";
ALTER INDEX "sqlite_autoindex_cart_items_1" RENAME TO "cart_items_user_id_product_id_key";
