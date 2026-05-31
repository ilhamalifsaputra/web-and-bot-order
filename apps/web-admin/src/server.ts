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
import { config } from "@app/core/config";
import { logger } from "@app/core/logger";
import viewsPlugin from "./plugins/views";
import authPlugin from "./plugins/auth";
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
import supportRoutes from "./routes/support";
import settingsRoutes from "./routes/settings";
import auditRoutes from "./routes/audit";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(HERE, "..", "static");

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: "/static/" });
  await app.register(viewsPlugin);
  await app.register(authPlugin);

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
  await app.register(supportRoutes);
  await app.register(settingsRoutes);
  await app.register(auditRoutes);

  return app;
}

export async function start(): Promise<void> {
  const { initDb } = await import("@app/db");
  await initDb();
  const app = await buildApp();
  await app.listen({ host: config.WEB_HOST, port: config.WEB_PORT });
  logger.info(`Web admin listening on http://${config.WEB_HOST}:${config.WEB_PORT}`);
}
