/**
 * Page-shaped JSON reads for the React SPA (/api/v1/pages/*) — JSON twins of
 * the Nunjucks page contexts, shaped by the SAME pageData.ts helpers the HTML
 * routes use, so the two fronts can never drift while both are alive.
 * Client types: apps/storefront/client/src/api/types.ts — keep in sync.
 *
 * The customer's CSRF token is deliberately NOT in any payload here — it
 * travels via the SPA shell's <meta name="csrf-token"> (routes/spaShell.ts),
 * mirroring web-admin.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { localize } from "@app/core/datetime";
import { UserRole } from "@app/core/enums";
import { prisma, getSetting, hasActiveFlashSale } from "@app/db";
import { optionalCustomer } from "../plugins/auth";
import { requestLang, readGuestCart, resolveBotUsername } from "../shop";
import { getUsdIdrRate } from "../pricing";
import {
  homePageData,
  categoryPageData,
  productPageData,
  searchPageData,
  allProductsPageData,
  flashPageData,
  categoriesPageData,
} from "../pageData";
import { isSortKey } from "../cards";

const apiPagesRoutes: FastifyPluginAsync = async (app) => {
  // ---- Shop chrome context (header/footer/cart badge) ----
  app.get("/pages/context", async (req, reply) => {
    const customer = await optionalCustomer(req);
    const [fxRate, shopName, shopTagline, cartCount, favicon, logo, botUsername, analyticsId, flashOn] = await Promise.all([
      getUsdIdrRate(prisma),
      getSetting(prisma, "shop_name"),
      getSetting(prisma, "shop_tagline"),
      customer
        ? prisma.cartItem
            .aggregate({ where: { userId: customer.userId }, _sum: { quantity: true } })
            .then((r) => r._sum.quantity ?? 0)
        : Promise.resolve(readGuestCart(req).reduce((n, l) => n + l.q, 0)),
      getSetting(prisma, "web_favicon_url"),
      getSetting(prisma, "web_logo_url"),
      resolveBotUsername(),
      getSetting(prisma, "web_analytics_id"),
      hasActiveFlashSale(prisma),
    ]);
    return reply.send({
      lang: requestLang(req),
      fx: fxRate ? fxRate.toString() : null,
      shop_name: shopName ?? "Toko Digital",
      shop_tagline: shopTagline ?? "",
      cart_count: cartCount,
      customer: customer
        ? {
            username: customer.user.loginUsername ?? customer.user.username,
            email: customer.user.email,
            telegram_linked: customer.user.telegramId != null,
          }
        : null,
      favicon_url: favicon || "/static/favicon.svg",
      logo_url: logo || "",
      bot_username: botUsername,
      tzname: config.TIMEZONE,
      // Whether this shop loads Google Analytics at all — the privacy page
      // only mentions tracking when there genuinely is some. The ID itself
      // stays server-side; the client has no use for it.
      analytics_enabled: (analyticsId ?? "").trim() !== "",
      // Whether any flash sale is live right now — the nav drawer hides its
      // "Flash sale" entry rather than link to an empty shelf. The client
      // caches this context for 30s, so the extra query is per-visit, not
      // per-navigation.
      flash_active: flashOn,
    });
  });

  // ---- Home ----
  app.get("/pages/home", async (_req, reply) => {
    return reply.send(await homePageData());
  });

  // ---- Category ----
  app.get<{ Params: { slug: string }; Querystring: { sort?: string } }>(
    "/pages/category/:slug",
    async (req, reply) => {
      const sort = isSortKey(req.query.sort) ? req.query.sort : "default";
      const data = await categoryPageData(req.params.slug, sort);
      if (!data) return reply.code(404).send({ error: "not_found" });
      return reply.send(data);
    },
  );

  // ---- Product detail ----
  app.get<{ Params: { slug: string } }>("/pages/product/:slug", async (req, reply) => {
    // Price the page for whoever is asking — a reseller pays
    // min(resellerPrice, flashPrice) at checkout, so quoting the everyone-price
    // here would show them a number they'll never be charged.
    const viewer = await optionalCustomer(req);
    const data = await productPageData(
      req.params.slug,
      viewer?.user.role === UserRole.RESELLER,
    );
    if (!data) return reply.code(404).send({ error: "not_found" });
    return reply.send({
      ...data,
      // Dates leave the API pre-formatted in the shop timezone — the same
      // localize() the Nunjucks localdt filter used — so the React page
      // renders byte-identical strings without shipping luxon+tz data.
      reviews: data.reviews.map((r) => ({
        rating: r.rating,
        comment: r.comment,
        author: r.author,
        created_at_display: localize(r.created_at, "yyyy-LL-dd"),
      })),
    });
  });

  // ---- Search ----
  app.get<{ Querystring: { q?: string; sort?: string } }>("/pages/search", async (req, reply) => {
    const sort = isSortKey(req.query.sort) ? req.query.sort : "default";
    return reply.send(await searchPageData(req.query.q ?? "", sort));
  });

  // ---- Browse-all shelves reached from the nav drawer ----
  app.get<{ Querystring: { sort?: string } }>("/pages/products", async (req, reply) => {
    const sort = isSortKey(req.query.sort) ? req.query.sort : "default";
    return reply.send(await allProductsPageData(sort));
  });

  app.get<{ Querystring: { sort?: string } }>("/pages/flash", async (req, reply) => {
    const sort = isSortKey(req.query.sort) ? req.query.sort : "default";
    return reply.send(await flashPageData(sort));
  });

  app.get("/pages/categories", async (_req, reply) => {
    return reply.send(await categoriesPageData());
  });
};

export default apiPagesRoutes;
