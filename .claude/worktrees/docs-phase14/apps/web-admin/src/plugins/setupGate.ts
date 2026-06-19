/**
 * First-run gate (spec §3). While setup is pending, every request is bounced to
 * the wizard at /setup, except the wizard itself, static/uploads, health, and
 * the favicon. Registered as a non-encapsulated onRequest hook so it covers all
 * routes regardless of registration order.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma, setupNeeded } from "@app/db";

const EXCLUDED = ["/setup", "/static", "/uploads", "/healthz", "/favicon.ico"];
const isExcluded = (path: string): boolean =>
  EXCLUDED.some((p) => path === p || path.startsWith(p + "/"));

const setupGate: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url.split("?")[0] || req.url) ?? "/";
    if (isExcluded(path)) return;
    if (await setupNeeded(prisma)) {
      return reply.code(303).redirect("/setup");
    }
  });
};

export default fp(setupGate, { name: "setupGate" });
