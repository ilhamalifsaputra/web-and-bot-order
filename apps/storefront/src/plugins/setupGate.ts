/**
 * Storefront first-run gate (spec §3). The storefront has no /setup route (the
 * wizard lives on the admin host), so while setup is pending we serve a static
 * "shop not active yet" page (HTTP 503) for every page request except health
 * and static assets — never a redirect to a route this host doesn't serve.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { prisma, setupNeeded } from "@app/db";
import { requestLang } from "../shop";

const EXCLUDED = ["/static", "/uploads", "/healthz", "/favicon.ico"];
const isExcluded = (path: string): boolean =>
  EXCLUDED.some((p) => path === p || path.startsWith(p + "/"));

const setupGate: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url.split("?")[0] || req.url) ?? "/";
    if (isExcluded(path)) return;
    if (await setupNeeded(prisma)) {
      const lang = requestLang(req);
      return reply.code(503).view("setup_pending.njk", { lang });
    }
  });
};

export default fp(setupGate, { name: "storefrontSetupGate" });
