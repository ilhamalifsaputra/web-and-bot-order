/**
 * Home + language switch. The home page is the shop window: hero, category
 * pills, newest products (design.md §5). Read-only — all data via crud, shaped
 * by pageData.ts (shared with the JSON API during the React migration).
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { shopContext, LANG_COOKIE } from "../shop";
import { homePageData } from "../pageData";

const homeRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req, reply) => {
    const ctx = await shopContext(req, "/");
    return reply.view("home.njk", { ...ctx, ...(await homePageData()) });
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
