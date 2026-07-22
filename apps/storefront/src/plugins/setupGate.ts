/**
 * Storefront first-run gate (spec §3). The storefront has no /setup route (the
 * wizard lives on the admin host), so while setup is pending we serve the
 * "shop not active yet" screen (HTTP 503, React SetupPendingPage — see
 * lib/spaFallback.ts) for every page request except health and static assets
 * — never a redirect to a route this host doesn't serve.
 */
import fp from "fastify-plugin";
import type { FastifyPluginAsync } from "fastify";
import { t } from "@app/core/i18n";
import { prisma, setupNeeded } from "@app/db";
import { requestLang } from "../shop";
import { renderSpecialShell, esc } from "../lib/spaFallback";

const EXCLUDED = ["/static", "/uploads", "/healthz", "/favicon.ico"];
const isExcluded = (path: string): boolean =>
  EXCLUDED.some((p) => path === p || path.startsWith(p + "/"));

const setupGate: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req, reply) => {
    const path = (req.url.split("?")[0] || req.url) ?? "/";
    if (isExcluded(path)) return;
    if (await setupNeeded(prisma)) {
      const lang = requestLang(req);
      const heading = t("web.setup_pending_title", lang);
      const message = t("web.setup_pending_message", lang);
      renderSpecialShell(reply, {
        status: 503,
        lang,
        metaTag: '<meta name="setup-pending" content="true">',
        title: heading,
        seoBodyHtml: `<h1>${esc(heading)}</h1><p>${esc(message)}</p>`,
        fallbackBodyHtml:
          `<main class="max-w-md text-center px-6">` +
          `<div class="wait-dot" aria-hidden="true"></div>` +
          `<h1 class="font-display text-2xl font-semibold mb-3">${esc(heading)}</h1>` +
          `<p class="text-ink-soft">${esc(message)}</p>` +
          `</main>`,
      });
      return reply;
    }
  });
};

export default fp(setupGate, { name: "storefrontSetupGate" });
