-- Phase H (customer-action audit trail), Task 1: extend AuditLog to support
-- customer-initiated entries alongside the existing admin-initiated ones.
-- Purely additive — every new column is either DEFAULT'd (actorType) or
-- nullable, so every existing row and every existing logAdminAction call
-- site keeps working with zero code change beyond this migration.

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "actor_type" TEXT NOT NULL DEFAULT 'ADMIN',
ADD COLUMN     "channel" TEXT,
ADD COLUMN     "correlation_id" TEXT,
ADD COLUMN     "customer_id" INTEGER,
ADD COLUMN     "telegram_user_id" BIGINT;

-- CreateIndex
CREATE INDEX "ix_audit_logs_customer_id" ON "audit_logs"("customer_id");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
