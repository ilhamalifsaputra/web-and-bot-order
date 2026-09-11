-- Fase 6 cleanup: remove the legacy Alembic version table left over from the
-- retired Python/SQLAlchemy stack. The Node stack never used it. Run once,
-- after the production cutover is confirmed (the Prisma schema no longer models
-- this table, so leaving it is harmless — this just tidies it away).
DROP TABLE IF EXISTS "alembic_version";
