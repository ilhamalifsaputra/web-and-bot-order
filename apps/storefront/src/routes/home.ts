/**
 * Language switch. The home page itself (GET /) cut over to the React SPA
 * (routes/spaShell.ts) at the Cluster A cutover — its data now comes from
 * GET /api/v1/pages/home (routes/apiPages.ts, shaped by pageData.ts). This
 * file only keeps the still-live `GET /lang` endpoint.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { LANG_COOKIE } from "../shop";

const homeRoutes: FastifyPluginAsync = async (app) => {
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
