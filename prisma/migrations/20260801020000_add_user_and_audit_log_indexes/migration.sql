-- Task 43 (M-34, backend audit 2026-07-31): index the filter/sort columns the
-- Customers and Audit Log admin surfaces actually query. `User` had no index
-- beyond its unique constraints, while the Customers page filters/sorts on
-- role, banned, createdAt, and lastSeenAt; `AuditLog` indexed createdAt only,
-- while its filter also matches on targetType/targetId. Without these, every
-- Customers/Audit Log page load (and rankUserIdsBySpend's ranking query) was
-- a full table scan.
--
-- Pasted verbatim from `prisma migrate diff --from-migrations
-- ./prisma/migrations --to-schema-datamodel ./prisma/schema.prisma --script`
-- after adding the three `@@index` lines to schema.prisma (User.[role,
-- createdAt], User.lastSeenAt, AuditLog.[targetType, targetId]) — all three
-- are plain `CREATE INDEX` statements, no table rebuild, no DROP TABLE, so no
-- cascade-delete exposure on User (a parent table with many children: orders,
-- tickets, wallet transactions, referrals, reviews, etc.) or AuditLog.
--
-- Verified: re-running the same `prisma migrate diff ... --exit-code`
-- command after this file was added reports "No difference detected."
-- (exit 0).

-- CreateIndex
CREATE INDEX "ix_audit_logs_target" ON "audit_logs"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "ix_users_role_created_at" ON "users"("role", "created_at");

-- CreateIndex
CREATE INDEX "ix_users_last_seen_at" ON "users"("last_seen_at");
