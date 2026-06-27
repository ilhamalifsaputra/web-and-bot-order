/**
 * Fastify app factory — port of app/main.py. Registers cookie/formbody/static,
 * the auth decorator, a friendly error handler, and all routers. `buildApp()`
 * returns the app without listening so tests can drive it with `app.inject()`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import authPlugin from "./plugins/auth";
import setupGatePlugin from "./plugins/setupGate";
import authRoutes from "./routes/auth";
import unauthShellRoutes from "./routes/unauthShell";
import setupRoutes from "./routes/setup";
import setupShellRoutes from "./routes/setupShell";
import spaShellRoutes from "./routes/spaShell";
import dashboardApiRoutes from "./routes/api/dashboard";
import auditApiRoutes from "./routes/api/audit";
import outboxApiRoutes from "./routes/api/outbox";
import reportsApiRoutes from "./routes/api/reports";
import reviewsApiRoutes from "./routes/api/reviews";
import searchApiRoutes from "./routes/api/search";
import vouchersApiRoutes from "./routes/api/vouchers";
import adminsApiRoutes from "./routes/api/admins";
import paymentsApiRoutes from "./routes/api/payments";
import usersApiRoutes from "./routes/api/users";
import broadcastApiRoutes from "./routes/api/broadcast";
import supportApiRoutes from "./routes/api/support";
import settingsApiRoutes from "./routes/api/settings";
import brandingApiRoutes from "./routes/api/branding";
import catalogApiRoutes from "./routes/api/catalog";
import stockApiRoutes from "./routes/api/stock";
import ordersApiRoutes from "./routes/api/orders";
import stockRoutes from "./routes/stock";
import ordersRoutes from "./routes/orders";
import paymentsRoutes from "./routes/payments";
import outboxRoutes from "./routes/outbox";
import catalogRoutes from "./routes/catalog";
import vouchersRoutes from "./routes/vouchers";
import usersRoutes from "./routes/users";
import reviewsRoutes from "./routes/reviews";
import reportsRoutes from "./routes/reports";
import searchRoutes from "./routes/search";
import adminsRoutes from "./routes/admins";
import broadcastRoutes from "./routes/broadcast";
import supportRoutes from "./routes/support";
import settingsRoutes from "./routes/settings";
import auditRoutes from "./routes/audit";
import brandingRoutes from "./routes/branding";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable via env so the bundled deploy can point at the shipped static/
// dir (import.meta.url moves to dist/ after bundling).
const STATIC_DIR = process.env.STATIC_DIR ?? join(HERE, "..", "static");
// Uploaded product photos land here; served at /uploads/ by both apps so the
// storefront can also serve them with no cross-origin complexity. Single source
// of truth in ./paths so the upload writers (catalog / branding) agree with this
// reader regardless of process.cwd().
export { UPLOADS_DIR } from "./paths";
import { UPLOADS_DIR } from "./paths";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // L-01: lightweight access log for 502/4xx/5xx diagnosis. Method + path +
  // status + duration only — never the query string (may carry reset tokens),
  // body, or headers (never log secrets — CLAUDE.md).
  app.addHook("onResponse", (req, reply, done) => {
    logger.info(
      { method: req.method, path: req.url.split("?", 1)[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      "Handled web admin request",
    );
    done();
  });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart);
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: "/static/" });
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

  // Friendly error page; never log the request body (it may carry secrets).
  app.setErrorHandler((err, req, reply) => {
    logger.error({ err, method: req.method, path: req.url }, "Unhandled error in a web admin request — serving the generic error page instead of crashing");
    if (!reply.sent) {
      const html =
        `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
        `<title>500 Internal server error</title></head><body>` +
        `<h1>500 — Internal server error</h1>` +
        `<p>Something went wrong. The details have been logged.</p>` +
        `</body></html>`;
      void reply.code(500).header("content-type", "text/html; charset=utf-8").send(html);
    }
  });

  await app.register(authRoutes);
  await app.register(unauthShellRoutes);
  await app.register(setupRoutes);
  await app.register(setupShellRoutes);
  await app.register(dashboardApiRoutes);
  await app.register(auditApiRoutes);
  await app.register(outboxApiRoutes);
  await app.register(reportsApiRoutes);
  await app.register(reviewsApiRoutes);
  await app.register(searchApiRoutes);
  await app.register(vouchersApiRoutes);
  await app.register(adminsApiRoutes);
  await app.register(paymentsApiRoutes);
  await app.register(usersApiRoutes);
  await app.register(broadcastApiRoutes);
  await app.register(supportApiRoutes);
  await app.register(settingsApiRoutes);
  await app.register(brandingApiRoutes);
  await app.register(catalogApiRoutes);
  await app.register(stockApiRoutes);
  await app.register(ordersApiRoutes);
  await app.register(stockRoutes);
  await app.register(ordersRoutes);
  await app.register(paymentsRoutes);
  await app.register(outboxRoutes);
  await app.register(catalogRoutes);
  await app.register(vouchersRoutes);
  await app.register(usersRoutes);
  await app.register(reviewsRoutes);
  await app.register(reportsRoutes);
  await app.register(searchRoutes);
  await app.register(adminsRoutes);
  await app.register(broadcastRoutes);
  await app.register(supportRoutes);
  await app.register(settingsRoutes);
  await app.register(auditRoutes);
  await app.register(brandingRoutes);
  // Wildcard SPA catch-all — MUST be last so specific API/auth routes win.
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
  await app.listen({ host: config.WEB_HOST, port: config.WEB_PORT });
  logger.info(`Web admin listening on http://${config.WEB_HOST}:${config.WEB_PORT}`);
}
