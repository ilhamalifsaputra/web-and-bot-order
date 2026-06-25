/**
 * Serves the React dashboard's built SPA shell at "/", replacing the
 * Nunjucks dashboard.njk render. The built index.html (Vite output, with a
 * `__CSRF_TOKEN__` placeholder baked in at apps/web-admin/client/index.html)
 * is read and the placeholder substituted with this session's real CSRF
 * token before sending — Vite's build never sees a real token, so its
 * output is a safe, cacheable static artifact.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { currentAdmin } from "../plugins/auth";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? join(HERE, "..", "..", "static");
const SPA_INDEX_PATH = join(STATIC_DIR, "dashboard-app", "index.html");

export default async function spaShellRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { preHandler: currentAdmin }, async (req, reply) => {
    const html = readFileSync(SPA_INDEX_PATH, "utf-8").replace("__CSRF_TOKEN__", req.admin?.csrf ?? "");
    return reply.type("text/html").send(html);
  });
}
