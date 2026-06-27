-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_order_items" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "order_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "stock_item_id" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL NOT NULL,
    "warranty_days_snapshot" INTEGER NOT NULL,
    CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "order_items_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "stock_items" ("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
INSERT INTO "new_order_items" ("id", "order_id", "product_id", "quantity", "stock_item_id", "unit_price", "warranty_days_snapshot") SELECT "id", "order_id", "product_id", "quantity", "stock_item_id", "unit_price", "warranty_days_snapshot" FROM "order_items";
DROP TABLE "order_items";
ALTER TABLE "new_order_items" RENAME TO "order_items";
CREATE INDEX "ix_order_items_order_id" ON "order_items"("order_id");
CREATE TABLE "new_referrals" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "referrer_id" INTEGER NOT NULL,
    "referee_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "commission" DECIMAL NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "referrals_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "referrals_referee_id_fkey" FOREIGN KEY ("referee_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "referrals_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
INSERT INTO "new_referrals" ("commission", "created_at", "id", "order_id", "paid", "referee_id", "referrer_id") SELECT "commission", "created_at", "id", "order_id", "paid", "referee_id", "referrer_id" FROM "referrals";
DROP TABLE "referrals";
ALTER TABLE "new_referrals" RENAME TO "referrals";
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_referrals_1" ON "referrals"("referee_id");
Pragma writable_schema=0;
CREATE INDEX "ix_referrals_referrer_id" ON "referrals"("referrer_id");
CREATE TABLE "new_reviews" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "denominations" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
INSERT INTO "new_reviews" ("comment", "created_at", "hidden", "id", "order_id", "product_id", "rating", "user_id") SELECT "comment", "created_at", "hidden", "id", "order_id", "product_id", "rating", "user_id" FROM "reviews";
DROP TABLE "reviews";
ALTER TABLE "new_reviews" RENAME TO "reviews";
CREATE INDEX "ix_reviews_product_id" ON "reviews"("product_id");
Pragma writable_schema=1;
CREATE UNIQUE INDEX "sqlite_autoindex_reviews_1" ON "reviews"("user_id", "order_id");
Pragma writable_schema=0;
CREATE TABLE "new_wallet_transactions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "user_id" INTEGER NOT NULL,
    "delta" DECIMAL NOT NULL,
    "balance_after" DECIMAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'IDR',
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "admin_id" INTEGER,
    "order_id" INTEGER,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "wallet_transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
INSERT INTO "new_wallet_transactions" ("admin_id", "balance_after", "created_at", "currency", "delta", "id", "note", "order_id", "reason", "user_id") SELECT "admin_id", "balance_after", "created_at", "currency", "delta", "id", "note", "order_id", "reason", "user_id" FROM "wallet_transactions";
DROP TABLE "wallet_transactions";
ALTER TABLE "new_wallet_transactions" RENAME TO "wallet_transactions";
CREATE INDEX "ix_wallet_transactions_user_id" ON "wallet_transactions"("user_id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
