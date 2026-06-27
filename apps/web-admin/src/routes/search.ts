/**
 * Global search / quick-jump — WEB.md roadmap Tier 3 §13. One box resolves an
 * order by code, a user by TG id / username / name, or a product by name, and
 * either jumps straight to a unique order match or renders a grouped results
 * page. Read-only; reuses existing crud (no new helpers).
 */
import type { FastifyInstance } from "fastify";

export default async function searchRoutes(_app: FastifyInstance): Promise<void> {
  // GET /search retired — now served by React SPA via GET /api/search.
}
