// Audit page migrated to React (GET /api/audit) — this file kept for future
// mutation endpoints if needed. GET /audit now falls through to the SPA shell.
import type { FastifyInstance } from "fastify";

export default async function auditRoutes(_app: FastifyInstance): Promise<void> {
  // no handlers
}
