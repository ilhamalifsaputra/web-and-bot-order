/**
 * Home + language switch. The home page is the shop window: hero, category
 * pills, newest products (design.md §5). Read-only — all data via crud.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { botUsername } from "@app/core/runtime";
import {
  prisma,
  getSetting,
  listActiveCategories,
  listNewestActiveProducts,
  stockStatusCounts,
  productRatingSummaries,
} from "@app/db";
import { categoryImage, productImage, HERO_IMAGE } from "../images";
import { shopContext, LANG_COOKIE } from "../shop";

const homeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const ctx = await shopContext(req, "/");
    const [categories, products, stock, ratings, waNumber] = await Promise.all([
      listActiveCategories(prisma),
      listNewestActiveProducts(prisma, 12),
      stockStatusCounts(prisma),
      productRatingSummaries(prisma),
      // WhatsApp button on the contact section — set in web-admin Settings ›
      // Website; empty/unset hides the button.
      getSetting(prisma, "support_whatsapp"),
    ]);
    const ratingByProduct = new Map(ratings.map((r) => [r.productId, r]));
    return reply.view("home.njk", {
      ...ctx,
      hero_image: HERO_IMAGE,
      categories: categories.map((c) => ({ ...c, image: categoryImage(c.name) })),
      products: products.map((p) => ({
        id: p.id,
        name: p.name,
        category_name: p.category.name,
        price: p.price.toString(),
        image: productImage(p, p.category.name),
        available: stock[p.id]?.available ?? 0,
        rating: ratingByProduct.get(p.id)?.avg ?? null,
        rating_count: ratingByProduct.get(p.id)?.count ?? 0,
      })),
      low_threshold: config.LOW_STOCK_THRESHOLD,
      bot_username: botUsername() ?? "",
      wa_number: (waNumber ?? "").replace(/[^0-9]/g, ""),
    });
  });

  // Language switch (?to=id|en) — sets the cookie and bounces back.
  app.get("/lang", async (req, reply) => {
    const q = req.query as { to?: string; back?: string };
    const to = (q.to ?? "").toLowerCase() === "id" ? "id" : "en";
    void reply.setCookie(LANG_COOKIE, to, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.WEB_COOKIE_SECURE,
      maxAge: 60 * 60 * 24 * 365,
    });
    // Only bounce to a local path — never an absolute URL (open-redirect guard).
    const back = q.back && q.back.startsWith("/") && !q.back.startsWith("//") ? q.back : "/";
    return reply.code(303).redirect(back);
  });
};

export default homeRoutes;
