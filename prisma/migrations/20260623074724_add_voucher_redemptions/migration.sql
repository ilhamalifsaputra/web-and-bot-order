-- CreateTable
CREATE TABLE "voucher_redemptions" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "voucher_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "order_id" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "voucher_redemptions_voucher_id_fkey" FOREIGN KEY ("voucher_id") REFERENCES "vouchers" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "voucher_redemptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "voucher_redemptions_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

-- CreateIndex
CREATE UNIQUE INDEX "ix_voucher_redemptions_voucher_user" ON "voucher_redemptions"("voucher_id", "user_id");

-- CreateIndex
CREATE INDEX "ix_voucher_redemptions_order_id" ON "voucher_redemptions"("order_id");
