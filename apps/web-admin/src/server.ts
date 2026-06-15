/**
 * Fastify app factory — port of app/main.py. Registers cookie/formbody/static,
 * the Nunjucks views plugin, the auth decorator, a friendly error handler, and
 * all ten routers. `buildApp()` returns the app without listening so tests can
 * drive it with `app.inject()` (light-my-request).
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
import viewsPlugin from "./plugins/views";
import authPlugin from "./plugins/auth";
import setupGatePlugin from "./plugins/setupGate";
import authRoutes from "./routes/auth";
import dashboardRoutes from "./routes/dashboard";
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

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable via env so the bundled deploy can point at the shipped static/
// dir (import.meta.url moves to dist/ after bundling). See DEPLOY-HOSTINGER.md §3.
const STATIC_DIR = process.env.STATIC_DIR ?? join(HERE, "..", "static");
// Uploaded product photos land here; served at /uploads/ by both apps so the
// storefront can also serve them with no cross-origin complexity.
export const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "data", "uploads");

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart);
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: "/static/" });
  await app.register(fastifyStatic, { root: UPLOADS_DIR, prefix: "/uploads/", decorateReply: false });
  await app.register(viewsPlugin);
  await app.register(authPlugin);
  await app.register(setupGatePlugin);

  // Friendly error page; never log the request body (it may carry secrets).
  app.setErrorHandler((err, req, reply) => {
    logger.error({ err, method: req.method, path: req.url }, "Unhandled web error");
    if (!reply.sent) {
      void reply.code(500).view("error.njk", {
        admin: null,
        status_code: 500,
        title: "Internal server error",
        message: "Something went wrong. The details have been logged.",
      });
    }
  });

  await app.register(authRoutes);
  await app.register(dashboardRoutes);
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
