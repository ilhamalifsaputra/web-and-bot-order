-- Rename the unique indexes inherited from the SQLite era to the names Prisma
-- derives by default, so the schema no longer needs `map:` overrides for them.
--
-- Safe to run more than once, and on any database state. Each rename only
-- happens when the old index exists AND the new name is still free, so:
--   * a database that still has the sqlite_autoindex_* names is renamed;
--   * a database that `prisma db push` already renamed (the normal deploy path —
--     db push emits these exact ALTER INDEX ... RENAME statements itself, see
--     docs/MIGRATIONS.md) is left alone instead of failing with
--     `relation "sqlite_autoindex_categories_1" does not exist`;
--   * a fresh install created from the current schema.prisma, which never had
--     the old names, is left alone too.
-- `to_regclass` resolves the name through the session's search_path, exactly
-- like `ALTER INDEX` does, so the check and the rename always look at the same
-- schema (the drift check runs this inside `_migration_diff_shadow`, and the
-- test suite keeps several schemas in one database that share these names).
DO $$
DECLARE
  pair text[];
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['sqlite_autoindex_categories_1', 'categories_name_key'],
    ARRAY['sqlite_autoindex_reviews_1', 'reviews_user_id_order_id_key'],
    ARRAY['sqlite_autoindex_referrals_1', 'referrals_referee_id_key'],
    ARRAY['sqlite_autoindex_restock_subscriptions_1', 'restock_subscriptions_user_id_product_id_key'],
    ARRAY['sqlite_autoindex_cart_items_1', 'cart_items_user_id_product_id_key']
  ]
  LOOP
    IF EXISTS (
         SELECT 1 FROM pg_class
         WHERE oid = to_regclass(quote_ident(pair[1])) AND relkind = 'i'
       )
       AND to_regclass(quote_ident(pair[2])) IS NULL
    THEN
      EXECUTE format('ALTER INDEX %I RENAME TO %I', pair[1], pair[2]);
    END IF;
  END LOOP;
END $$;
