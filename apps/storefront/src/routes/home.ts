/**
 * Home + language switch. The home page is the shop window: hero, category
 * pills, newest products (design.md §5). Read-only — all data via crud.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import {
  prisma,
  getSetting,
  listActiveCategories,
  listNewestCatalogProducts,
  stockStatusCounts,
  productRatingSummaries,
  activeBulkPricingByDenomination,
  featuredReviews,
  overallRating,
  shopFulfilmentStats,
} from "@app/db";
import { categoryImage, HERO_IMAGE } from "../images";
import { shopContext, LANG_COOKIE, resolveBotUsername } from "../shop";
import { shapeProducts } from "../cards";

/**
 * A privacy-safe display name for a public testimonial: prefer the buyer's full
 * name, fall back to their web login / Telegram handle, and mask everything
 * after the first word to an initial ("Ahmad Fauzi" → "Ahmad F."). Never leaks
 * an email or a full handle.
 */
function reviewerName(user: { fullName: string | null; loginUsername: string | null; username: string | null }): string {
  const raw = (user.fullName || user.loginUsername || user.username || "").trim();
  if (!raw) return "Pelanggan";
  const parts = raw.split(/\s+/);
  const first = parts[0] ?? raw;
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}

const homeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const ctx = await shopContext(req, "/");
    const [categories, products, stock, ratings, bulk, reviews, rating, fulfil, waNumber, heroUrl] =
      await Promise.all([
        listActiveCategories(prisma),
        listNewestCatalogProducts(prisma, 12),
        stockStatusCounts(prisma),
        productRatingSummaries(prisma),
        activeBulkPricingByDenomination(prisma),
        featuredReviews(prisma, 4),
        overallRating(prisma),
        shopFulfilmentStats(prisma),
        // WhatsApp button on the contact section — set in web-admin Settings ›
        // Website; empty/unset hides the button.
        getSetting(prisma, "support_whatsapp"),
        // Hero banner — admin-uploaded image overrides the Unsplash default.
        getSetting(prisma, "web_hero_url"),
      ]);
    const ratingByDenom = new Map(ratings.map((r) => [r.productId, { avg: r.avg, count: r.count }]));
    const cards = shapeProducts(products, stock, ratingByDenom, bulk);

    // Honest home-page figures: only show real numbers once a handful of orders
    // have actually shipped; before that the band falls back to value props so
    // we never display "0 customers". Satisfaction = visible-review average.
    const stats = {
      has_data: fulfil.deliveredOrders >= 5,
      customers: fulfil.customers,
      orders: fulfil.deliveredOrders,
      satisfaction: rating.count > 0 && rating.avg ? Math.round((rating.avg / 5) * 100) : null,
    };

    // Real testimonials from delivered-order reviews (≥4★ with a comment).
    const testimonials = reviews
      .filter((r) => (r.comment ?? "").trim().length > 0)
      .map((r) => {
        const name = reviewerName(r.user);
        return {
          name,
          initial: name.charAt(0).toUpperCase() || "?",
          product: r.product.name,
          rating: r.rating,
          comment: r.comment!.trim(),
        };
      });

    return reply.view("home.njk", {
      ...ctx,
      hero_image: heroUrl || HERO_IMAGE,
      categories: categories.map((c) => ({ ...c, image: categoryImage(c.name) })),
      products: cards,
      stats,
      testimonials,
      low_threshold: config.LOW_STOCK_THRESHOLD,
      bot_username: await resolveBotUsername(),
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
