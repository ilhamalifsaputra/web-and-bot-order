/**
 * First-run gate (spec §3). While setup is pending, every request is bounced to
 * the wizard at /setup, except the wizard itself, static/uploads, health, and
 * the favicon. Registered as a non-encapsulated onRequest hook so it covers all
 * routes regardless of registration order.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma, setupNeeded } from "@app/db";

const EXCLUDED = ["/setup", "/static", "/uploads", "/healthz", "/metrics", "/favicon.ico"];
const isExcluded = (path: string): boolean =>
  EXCLUDED.some((p) => path === p || path.startsWith(p + "/"));

/** The message shown to an `/api/*` caller while first-run setup is still
 * pending — mirrors `SESSION_EXPIRED_MESSAGE` in plugins/auth.ts. */
export const SETUP_INCOMPLETE_MESSAGE = "Setup is not complete.";

const setupGate: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url.split("?")[0] || req.url) ?? "/";
    if (isExcluded(path)) return;
    if (await setupNeeded(prisma)) {
      // `/api/*` calls are JSON fetch()es, not page navigations — a 303 here
      // gets silently followed to the HTML /setup wizard (200 OK), which then
      // fails client-side JSON parsing (same class of bug as currentAdmin's
      // /login redirect — see apps/web-admin/src/plugins/auth.ts). Give those
      // a JSON error instead; real page navigations still get the redirect.
      if (path.startsWith("/api/")) {
        return reply.code(409).send({ error: SETUP_INCOMPLETE_MESSAGE });
      }
      return reply.code(303).redirect("/setup");
    }
  });
};

export default fp(setupGate, { name: "setupGate" });
