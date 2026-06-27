/**
 * Serves the React SPA shell for setup wizard GET routes.
 * These are unauthenticated routes (no session yet), so they use their own
 * shell instead of the authenticated spaShell. The lock check (checkSetupLock)
 * preserves the redirect-to-/login behavior once setup is complete.
 *
 * MUST be registered after setupRoutes in server.ts so that POST handlers in
 * setupRoutes win over these GET handlers if paths ever collide.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { prisma, getSetting } from "@app/db";
import { checkSetupLock } from "./setup";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = process.env.STATIC_DIR ?? join(HERE, "..", "..", "static");
const SPA_INDEX = join(STATIC_DIR, "dashboard-app", "index.html");

export default async function setupShellRoutes(app: FastifyInstance): Promise<void> {
  // These paths go through the lock check (redirect to /login if setup complete)
  for (const path of ["/setup", "/setup/owner", "/setup/shop"]) {
    app.get(path, async (_req, reply) => {
      if (await checkSetupLock(reply)) return; // already redirected
      const raw = readFileSync(SPA_INDEX, "utf-8");
      const html = raw.replace("__CSRF_TOKEN__", "");
      return reply.type("text/html").send(html);
    });
  }

  // /setup/done: no lock check (shown after setup completes)
  // Remove the Nunjucks GET handler from setup.ts and serve SPA here instead.
  // Inject meta tag telling React whether bot token was configured.
  app.get("/setup/done", async (_req, reply) => {
    const botConfigured = (await getSetting(prisma, "bot_token")) !== null;
    const raw = readFileSync(SPA_INDEX, "utf-8");
    const html = raw
      .replace("__CSRF_TOKEN__", "")
      .replace("</head>", `<meta name="setup-bot-configured" content="${botConfigured}"></head>`);
    return reply.type("text/html").send(html);
  });
}
