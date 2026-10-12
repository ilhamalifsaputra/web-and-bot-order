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
import { prisma, linkTelegram, logCustomerAction } from "@app/db";
import { consumeTelegramCallback, telegramCallbackShell } from "../telegramCallback";
import { sessionMintOriginOk } from "./cart";
import { verifyTelegramLogin } from "../auth";
import { optionalCustomer } from "../plugins/auth";
import { resolveBotToken } from "../shop";
import { linkTelegramRateLimited } from "../rateLimit";
import { consumeTelegramLinkIntent } from "../telegramLinkIntent";

const settingsRoutes: FastifyPluginAsync = async (app) => {
  // ---- GET /account/settings/link-telegram ----------------------------------
  app.route<{ Querystring: Record<string, string>; Body: Record<string,string> }>({
    method: ["GET", "POST"], url: "/account/settings/link-telegram",
    preHandler: async (req, reply) => {
      void reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
      const customer = await optionalCustomer(req);
      // A callback can carry signed query fields; never copy them into a login destination.
      if (!customer) return reply.code(303).redirect("/login?next=%2Faccount%2Fsettings");
      req.customer = customer;
    },
    handler: async (req, reply) => {
      void reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer");
      if (req.method === "GET" && !req.query.hash) return telegramCallbackShell(reply);
      const finish = (path: string) => req.method === "POST" ? reply.send({redirect:path}) : reply.code(303).redirect(path);
      if (req.method === "POST" && !sessionMintOriginOk(req)) return reply.code(403).send({error:"csrf_failed"});
      const customer = req.customer!;
      // Rate limit: linking is a rare, deliberate action (5/10min, mirrors
      // guestCheckoutRateLimited) — keyed by customer id since this route
      // only ever runs behind an authenticated session. Reuses the existing
      // ?err=tg_invalid redirect target rather than inventing a new `err`
      // value the client doesn't recognize.
      if (linkTelegramRateLimited(customer.userId)) {
        return finish("/account/settings?err=tg_invalid");
      }
      // A guest row's session can be minted from the order code alone
      // (POST /api/v1/track), so linking Telegram here would let whoever
      // guessed the code keep the row via /auth/telegram. The guest must
      // first claim it through the credentials form, which needs the order's
      // contact email (backend audit Task C fix round). linkTelegram refuses
      // too; this early exit just keeps the guest's link intent untouched.
      if (customer.user.isGuest) return finish("/account/settings?err=tg_guest");
      const {state, next: _next, ...fields} = (req.method === "POST" ? req.body : req.query) ?? {};
      const auth = verifyTelegramLogin(fields, await resolveBotToken());
      if (!auth) return finish("/account/settings?err=tg_invalid");
      // Only a link this account armed from its own settings page (CSRF-checked
      // POST .../link-telegram/start) — see telegramLinkIntent.ts.
      if (!consumeTelegramLinkIntent(customer.userId)) {
        return finish("/account/settings?err=tg_invalid");
      }
      if (!(await consumeTelegramCallback(req, reply, "link", state, fields.hash!))) return finish("/account/settings?err=tg_invalid");
      const fullName =
        [auth.first_name, auth.last_name].filter(Boolean).join(" ") || null;
      const res = await linkTelegram(
        prisma,
        customer.userId,
        auth.id,
        auth.username ?? null,
        fullName,
      );
      if (!res.ok) {
        const err = res.reason === "guest" ? "tg_guest" : res.reason === "already_linked" ? "tg_already_linked" : "tg_taken";
        return finish(`/account/settings?err=${err}`);
      }
      // Phase H customer-audit trail. This route is the one account-linking
      // entry point (see the file header comment) and it lives on the
      // storefront web app, not apps/order-bot — there is no Telegram Update
      // to derive a correlationId from, so it's left unset. targetType
      // "user" (not "customer"/"account_link") matches the vocabulary
      // logAdminAction call sites already use for a User-row target (e.g.
      // apps/order-bot/src/handlers/admin.ts's user_set_reseller/wallet_adjust).
      await logCustomerAction(prisma, {
        customerId: customer.userId,
        telegramUserId: BigInt(auth.id),
        channel: "WEB",
        action: "account_link_telegram",
        targetType: "user",
        targetId: customer.userId,
        details: auth.username
          ? `Linked the account to Telegram (@${auth.username}).`
          : "Linked the account to Telegram.",
      });
      return finish("/account/settings?linked=1");
    },
  });
};

export default settingsRoutes;
