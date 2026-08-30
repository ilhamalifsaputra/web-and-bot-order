-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "checkout_intent_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ix_orders_checkout_intent_id" ON "orders"("checkout_intent_id");
