/**
 * Serves the React SPA shell for unauthenticated pages (login, forgot,
 * reset, bootstrap). These routes must NOT use the `currentAdmin` preHandler
 * because the user is, by definition, not logged in yet.
 *
 * Unlike spaShell.ts, no CSRF token is injected — auth pages post to their
 * own JSON endpoints which don't need one. The `__CSRF_TOKEN__` placeholder
 * is replaced with an empty string so the SPA initialises cleanly.
 *
 * /bootstrap additionally injects the `admin-ids` meta tag so the React
 * page can read the allow-list without making a separate API call.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { config } from "@app/core/config";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPA_INDEX = process.env.STATIC_DIR
  ? join(process.env.STATIC_DIR, "dashboard-app", "index.html")
  : join(HERE, "..", "..", "static", "dashboard-app", "index.html");

export default async function unauthShellRoutes(app: FastifyInstance): Promise<void> {
  const AUTH_PATHS = ["/login", "/forgot", "/reset"];
  for (const path of AUTH_PATHS) {
    app.get(path, (_req, reply) => {
      const raw = readFileSync(SPA_INDEX, "utf-8");
      const html = raw.replace("__CSRF_TOKEN__", "");
      void reply.type("text/html").send(html);
    });
  }

  // /bootstrap injects the ADMIN_IDS allow-list so the React page can show
  // a hint without an extra API round-trip.
  app.get("/bootstrap", (_req, reply) => {
    const raw = readFileSync(SPA_INDEX, "utf-8");
    const adminIds = JSON.stringify(config.ADMIN_IDS);
    const html = raw
      .replace("__CSRF_TOKEN__", "")
      .replace("</head>", `<meta name="admin-ids" content='${adminIds}'></head>`);
    void reply.type("text/html").send(html);
  });
}
