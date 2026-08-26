/**
 * Account settings — Telegram Login Widget callback. The read/write
 * (credentials + settings snapshot) surface moved to the JSON twins in
 * routes/apiAccount.ts for the React SPA cutover
 * (docs/REACT_STOREFRONT_MIGRATION.md Phase 7); this route SURVIVES because
 * the Telegram widget redirects the whole page (not an XHR) — the React
 * SettingsPage points the widget's callback straight at it, and it still
 * redirects back to `/account/settings?linked=1|err=tg_taken|tg_invalid` for
 * the SPA to read from the URL.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, linkTelegram } from "@app/db";
import { verifyTelegramLogin } from "../auth";
import { currentCustomer } from "../plugins/auth";
import { resolveBotToken } from "../shop";
import { linkTelegramRateLimited } from "../rateLimit";

const settingsRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /account/settings/link-telegram ----------------------------------
  app.get<{ Querystring: Record<string, string> }>(
    "/account/settings/link-telegram",
    { preHandler: currentCustomer },
    async (req, reply) => {
      const customer = req.customer!;
      // Rate limit: linking is a rare, deliberate action (5/10min, mirrors
      // guestCheckoutRateLimited) — keyed by customer id since this route
      // only ever runs behind an authenticated session. Reuses the existing
      // ?err=tg_invalid redirect target rather than inventing a new `err`
      // value the client doesn't recognize.
      if (linkTelegramRateLimited(customer.userId)) {
        return reply.code(303).redirect("/account/settings?err=tg_invalid");
      }
      const auth = verifyTelegramLogin(req.query, await resolveBotToken());
      if (!auth) return reply.code(303).redirect("/account/settings?err=tg_invalid");
      const fullName =
        [auth.first_name, auth.last_name].filter(Boolean).join(" ") || null;
      const res = await linkTelegram(
        prisma,
        customer.userId,
        auth.id,
        auth.username ?? null,
        fullName,
      );
      if (!res.ok) return reply.code(303).redirect("/account/settings?err=tg_taken");
      return reply.code(303).redirect("/account/settings?linked=1");
    },
  );
};

export default settingsRoutes;
