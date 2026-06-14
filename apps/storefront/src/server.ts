/**
 * Storefront Fastify app factory — the customer-facing web (plan.md). Mirrors
 * apps/web-admin/src/server.ts: `buildApp()` returns the app without listening
 * so tests can drive it with `app.inject()`; `start()` boots standalone (dev).
 * In production it is mounted by the composition root (apps/server).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import fastifyStatic from "@fastify/static";
import { config } from "@app/core/config";
import { t } from "@app/core/i18n";
import { logger } from "@app/core/logger";
import viewsPlugin from "./plugins/views";
import authPlugin from "./plugins/auth";
import homeRoutes from "./routes/home";
import catalogRoutes from "./routes/catalog";
import authRoutes from "./routes/auth";
import forgotRoutes from "./routes/forgot";
import accountRoutes from "./routes/account";
import settingsRoutes from "./routes/settings";
import cartRoutes from "./routes/cart";
import checkoutRoutes from "./routes/checkout";
import { requestLang } from "./shop";

const HERE = dirname(fileURLToPath(import.meta.url));
// Overridable for the bundled deploy, same convention as web-admin.
const STATIC_DIR = process.env.STOREFRONT_STATIC_DIR ?? join(HERE, "..", "static");
// Shared with web-admin: product photos uploaded via the admin panel live here.
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? join(HERE, "..", "..", "..", "data", "uploads");

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(fastifyStatic, { root: STATIC_DIR, prefix: "/static/" });
  await app.register(fastifyStatic, { root: UPLOADS_DIR, prefix: "/uploads/", decorateReply: false });
  await app.register(viewsPlugin);
  await app.register(authPlugin);

  // Friendly error + 404 pages; never log the request body (may carry secrets).
  app.setErrorHandler((err, req, reply) => {
    logger.error({ err, method: req.method, path: req.url }, "Unhandled storefront error");
    if (!reply.sent) {
      const lang = requestLang(req);
      void reply.code(500).view("error.njk", {
        lang,
        status_code: 500,
        message: t("web.error_message", lang),
        shop_name: "",
        cart_count: 0,
        fx: null,
      });
    }
  });
  app.setNotFoundHandler((req, reply) => {
    const lang = requestLang(req);
    void reply.code(404).view("error.njk", {
      lang,
      status_code: 404,
      message: t("web.not_found", lang),
      shop_name: "",
      cart_count: 0,
      fx: null,
    });
  });

  await app.register(homeRoutes);
  await app.register(catalogRoutes);
  await app.register(authRoutes);
  await app.register(forgotRoutes);
  await app.register(accountRoutes);
  await app.register(settingsRoutes);
  await app.register(cartRoutes);
  await app.register(checkoutRoutes);

  // Liveness probe for the combined server / uptime pings (admin has its own).
  app.get("/healthz", async () => {
    const { prisma } = await import("@app/db");
    await prisma.$queryRaw`SELECT 1`;
    return { status: "ok" };
  });

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
