/**
 * Catalog pages (read-only, no login), 3-tier flow Category → Product →
 * Denomination on slug URLs:
 *   - `/c/:slug`  category page — Product cards only (never denomination rows);
 *   - `/p/:slug`  product detail — denomination cards (Buy Now / Add To Cart);
 *   - `/search`   products only (variants are chosen inside product detail).
 * Prices render as IDR (central price) + USDT info beside it (plan.md §15).
 * View-model shaping lives in pageData.ts, shared with the JSON API
 * (routes/apiPages.ts) during the React migration.
 */
import type { FastifyPluginAsync } from "fastify";
import { t } from "@app/core/i18n";
import { shopContext } from "../shop";
import { categoryPageData, productPageData, searchPageData } from "../pageData";

const catalogRoutes: FastifyPluginAsync = async (app) => {
  // ---- Category page — Product cards only ----
  app.get<{ Params: { slug: string } }>("/c/:slug", async (req, reply) => {
    const [ctx, data] = await Promise.all([
      shopContext(req, "/c"),
      categoryPageData(req.params.slug),
    ]);
    if (!data) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
    return reply.view("catalog.njk", { ...ctx, ...data });
  });

  // ---- Product detail — denomination cards + Buy Now / Add To Cart ----
  app.get<{ Params: { slug: string } }>("/p/:slug", async (req, reply) => {
    const [ctx, data] = await Promise.all([
      shopContext(req, "/p"),
      productPageData(req.params.slug),
    ]);
    if (!data) {
      return reply.code(404).view("error.njk", {
        ...ctx,
        status_code: 404,
        message: t("web.not_found", ctx.lang),
      });
    }
    return reply.view("product.njk", { ...ctx, ...data });
  });

  // ---- Search — products only ----
  app.get<{ Querystring: { q?: string } }>("/search", async (req, reply) => {
    const [ctx, data] = await Promise.all([
      shopContext(req, "/search"),
      searchPageData(req.query.q ?? ""),
    ]);
    return reply.view("search.njk", { ...ctx, ...data });
  });
};

export default catalogRoutes;
