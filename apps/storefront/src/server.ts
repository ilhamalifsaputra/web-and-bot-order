/**
 * Storefront Fastify app factory — the customer-facing web (plan.md). Mirrors
 * apps/web-admin/src/server.ts: `buildApp()` returns the app without listening
 * so tests can drive it with `app.inject()`; `start()` boots standalone (dev).
 * In production it is mounted by the composition root (apps/server).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config } from "@app/core/config";
import { t } from "@app/core/i18n";
import { logger } from "@app/core/logger";
import authPlugin from "./plugins/auth";
import setupGatePlugin from "./plugins/setupGate";
import homeRoutes from "./routes/home";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
import checkoutRoutes from "./routes/checkout";
import apiRoutes from "./routes/api";
import apiPagesRoutes from "./routes/apiPages";
import apiAuthRoutes from "./routes/apiAuth";
import apiCartRoutes from "./routes/apiCart";
import apiCheckoutRoutes from "./routes/apiCheckout";
import apiAccountRoutes from "./routes/apiAccount";
import seoRoutes from "./routes/seo";
import spaShellRoutes from "./routes/spaShell";
import { requestLang } from "./shop";
import { renderSpecialShell, esc } from "./lib/spaFallback";

// Scrubs a live, single-use password-reset token out of a request path
// before it's logged (CLAUDE.md: "Never log secrets"). The token has
// appeared as a path segment under two different route shapes over time —
// the deleted Nunjucks route `GET /reset/:token`, and the current React SPA
// JSON route `POST /api/v1/auth/reset/:token` — so this matches `/reset/...`
// ANYWHERE in the path, not just at the start, to cover both without needing
// another edit if the route moves again. Exported standalone (no Fastify
// dependency) so it's unit-testable directly.
export function redactPath(path: string): string {
  return path.replace(/\/reset\/[^/]+/g, "/reset/[redacted]");
}

/**
 * Shared shape for the error (500) / not-found (404) shells — a status-code
 * card matching the React ErrorPage (client/src/pages/ErrorPage.tsx), with a
 * `<meta name="server-error-status">` main.tsx reads to mount it directly
 * instead of the normal router. See lib/spaFallback.ts for the build-missing
 * last resort this falls back to.
 */
function renderErrorShell(
  reply: import("fastify").FastifyReply,
  status: number,
  lang: string,
  message: string,
): void {
  renderSpecialShell(reply, {
    status,
    lang,
    metaTag: `<meta name="server-error-status" content="${status}">`,
    title: String(status),
    seoBodyHtml: `<h1>${status}</h1><p>${esc(message)}</p>`,
    fallbackBodyHtml:
      `<main class="max-w-6xl mx-auto px-4 py-8 flex-1">` +
      `<div class="card card-pad max-w-lg mx-auto text-center py-14">` +
      `<div class="font-display text-5xl font-semibold text-ink-faint">${status}</div>` +
      `<p class="mt-3 text-ink-soft">${esc(message)}</p>` +
      `<a href="/" class="btn btn-primary mt-6">${esc(t("web.back_home", lang))}</a>` +
      `</div>` +
      `</main>`,
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable for the bundled deploy, same convention as web-admin.
const STATIC_DIR = process.env.STOREFRONT_STATIC_DIR ?? join(HERE, "..", "static");
// Shared with web-admin: product photos uploaded via the admin panel live here.
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "data", "uploads");

export async function buildApp(): Promise<FastifyInstance> {
  // trustProxy unset (default) → false: X-Forwarded-For is ignored entirely,
  // req.ip is the real TCP peer. Only set TRUST_PROXY once an actual reverse
  // proxy is in front (Storefront-4 fix, security audit 2026-06-23) — see
  // packages/core/src/config.ts for the full rationale.
  const trustProxy = config.TRUST_PROXY
    ? config.TRUST_PROXY.split(",").map((s) => s.trim()).filter(Boolean)
    : false;
  const app = Fastify({ logger: false, trustProxy });

  // L-01: lightweight access log for 502/4xx/5xx diagnosis. Method + path +
  // status + duration only — never the query string (may carry tokens), body,
  // or headers (never log secrets — CLAUDE.md). The password-reset token
  // rides in the PATH (`/reset/:token`), not the query string, so it's
  // redacted explicitly here too via redactPath() (Storefront-1 fix, security
  // audit 2026-06-23) — otherwise every reset-page hit would log the live,
  // single-use token in full.
  app.addHook("onResponse", (req, reply, done) => {
    const rawPath = req.url.split("?", 1)[0]!;
    const path = redactPath(rawPath);
    logger.info(
      { method: req.method, path, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      "Handled a storefront HTTP request",
    );
    done();
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart);
  // SEO/perf: gzip/br/zstd HTML, JSON and static-asset responses. `global: true`
  // is the plugin default, so every route (SPA shell, /api/v1/*, /static/*) gets
  // compressed transparently. Must be registered before @fastify/static per its
  // own docs, so the compress hook wraps the static-file send path too.
  await app.register(compress);
  // Long-lived immutable caching is safe here ONLY because Vite content-hashes
  // every built asset's filename (e.g. index-BWFJ4i1w.js) — a new deploy ships
  // under a new URL, so there's no staleness risk. Do NOT copy these options to
  // the UPLOADS_DIR registration below: product photos are admin-replaceable at
  // the same URL with no content hash, so long caching there would serve stale
  // images after an update.
  await app.register(fastifyStatic, {
    root: STATIC_DIR,
    prefix: "/static/",
    cacheControl: true,
    maxAge: "1y",
    immutable: true,
  });
  await app.register(fastifyStatic, {
    root: UPLOADS_DIR,
    prefix: "/uploads/",
    decorateReply: false,
    // Make user-uploaded SVGs inert: no script execution if opened directly.
    setHeaders: (res: import("@fastify/static").SetHeadersResponse) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    },
  });
  await app.register(authPlugin);
  await app.register(setupGatePlugin);

  // Friendly error + 404 pages; never log the request body (may carry secrets).
  // API paths get JSON errors instead — the SPA's fetch layer reads
  // `data.error`, and an HTML body would just make it throw a parse error.
  app.setErrorHandler((err, req, reply) => {
    logger.error({ err, method: req.method, path: redactPath(req.url.split("?", 1)[0]!) }, "Unhandled error in a storefront request — serving the generic error page to the visitor");
    if (!reply.sent) {
      if (req.url.startsWith("/api/")) {
        return reply.code(500).send({ error: "error.generic" });
      }
      const lang = requestLang(req);
      renderErrorShell(reply, 500, lang, t("web.error_message", lang));
    }
  });
  // Unmatched GETs fall through to the SPA shell wildcard below, so this
  // handler now only sees non-GET misses (and /api/* misses of any method).
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const lang = requestLang(req);
    renderErrorShell(reply, 404, lang, t("web.not_found", lang));
  });

  await app.register(homeRoutes);
  await app.register(authRoutes);
  await app.register(settingsRoutes);
  await app.register(checkoutRoutes);
  await app.register(apiRoutes, { prefix: "/api/v1" });
  // React-SPA JSON layer (docs/REACT_STOREFRONT_MIGRATION.md) — same /api/v1
  // prefix, additive alongside the Nunjucks routes until each cluster cuts over.
  await app.register(apiPagesRoutes, { prefix: "/api/v1" });
  await app.register(apiAuthRoutes, { prefix: "/api/v1" });
  await app.register(apiCartRoutes, { prefix: "/api/v1" });
  await app.register(apiCheckoutRoutes, { prefix: "/api/v1" });
  await app.register(apiAccountRoutes, { prefix: "/api/v1" });
  await app.register(seoRoutes);

  // Liveness probe for the combined server / uptime pings (admin has its own).
  app.get("/healthz", async () => {
    const { prisma } = await import("@app/db");
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  });

  // React SPA shell — wildcard GET, MUST be registered last so every specific
  // route above wins; serves pages whose Nunjucks handler has been deleted.
  await app.register(spaShellRoutes);

  return app;
}

export async function start(): Promise<void> {
  const { initDb, prisma, resolveAdminIds, resolveWebCookieSecret } = await import("@app/db");
  const { setAdminIds, setWebSecret } = await import("@app/core/runtime");
  await initDb();
  setAdminIds(await resolveAdminIds(prisma));
  setWebSecret(await resolveWebCookieSecret(prisma));
  const app = await buildApp();
  const port = Number(process.env.STOREFRONT_PORT ?? 8100);
  await app.listen({ host: config.WEB_HOST, port });
  logger.info(`Storefront listening on http://${config.WEB_HOST}:${port}`);
}
