/**
 * Customer login/logout. /login renders the Telegram Login Widget; Telegram
 * redirects back to /auth/telegram with signed params; we verify the HMAC,
 * upsert the User (same crud the bot's /start uses), merge any guest-cart
 * cookie into CartItem rows (plan.md §5 decision D), set the session cookie,
 * and bounce to `next`.
 *
 * Onboarding parity (plan.md §17.2 #7): /login?ref=CODE carries a referral
 * code through the widget round-trip so first-time web users get attributed
 * exactly like bot users who tap a ref_ deep link.
 */
import type { FastifyPluginAsync } from "fastify";
import { config } from "@app/core/config";
import { botUsername } from "@app/core/runtime";
import { logger } from "@app/core/logger";
import { prisma, upsertUser, setSetting, addToCart, getProduct } from "@app/db";
import {
  makeCustomerSession,
  newJti,
  shopSessionJtiKey,
  verifyTelegramLogin,
  SHOP_COOKIE_NAME,
  SHOP_SESSION_TTL_HOURS,
} from "../auth";
import { shopContext, readGuestCart, writeGuestCart } from "../shop";

/** Only ever redirect to a local path (open-redirect guard). */
const safeNext = (raw: unknown): string => {
  const s = typeof raw === "string" ? raw : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
};

const authRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { next?: string; ref?: string } }>("/login", async (req, reply) => {
    const ctx = await shopContext(req, "/login");
    // Telegram appends its auth params to this URL with & (it already has ?).
    const params = new URLSearchParams();
    params.set("next", safeNext(req.query.next));
    if (req.query.ref) params.set("ref", req.query.ref.slice(0, 16));
    return reply.view("login.njk", {
      ...ctx,
      bot_username: botUsername() ?? "",
      auth_url: `/auth/telegram?${params.toString()}`,
    });
  });

  app.get<{ Querystring: Record<string, string> }>("/auth/telegram", async (req, reply) => {
    const { next, ref, ...tgParams } = req.query;
    const auth = verifyTelegramLogin(tgParams);
    const ctx = await shopContext(req, "/login");
    if (!auth) {
      logger.warn("Storefront: rejected Telegram login (bad hash or stale auth_date)");
      return reply.code(403).view("login.njk", {
        ...ctx,
        bot_username: botUsername() ?? "",
        auth_url: "/auth/telegram",
        error: true,
      });
    }

    const fullName = [auth.first_name, auth.last_name].filter(Boolean).join(" ") || null;
    const user = await upsertUser(prisma, {
      telegramId: auth.id,
      username: auth.username ?? null,
      fullName,
      referredByCode: ref ? ref.toUpperCase() : null,
    });
    if (user.banned) {
      return reply.code(403).view("login.njk", {
        ...ctx,
        bot_username: botUsername() ?? "",
        auth_url: "/auth/telegram",
        error: true,
      });
    }

    // Merge the guest cart into CartItem rows, then clear the cookie (D).
    const guestCart = readGuestCart(req);
    for (const line of guestCart) {
      const product = await getProduct(prisma, line.p);
      if (product?.isActive) await addToCart(prisma, user.id, line.p, line.q);
    }
    if (guestCart.length) writeGuestCart(reply, []);

    // Fresh jti per login; the settings row is what makes logout stick.
    const jti = newJti();
    await setSetting(prisma, shopSessionJtiKey(auth.id), jti);
    const { raw } = makeCustomerSession(user.id, auth.id, jti);
    void reply.setCookie(SHOP_COOKIE_NAME, raw, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.WEB_COOKIE_SECURE,
      maxAge: SHOP_SESSION_TTL_HOURS * 3600,
    });
    return reply.code(303).redirect(safeNext(next));
  });

  // Logout — POST only (state change), rotates the server-side jti.
  app.post("/logout", async (req, reply) => {
    const { optionalCustomer } = await import("../plugins/auth");
    const customer = await optionalCustomer(req);
    if (customer) {
      await setSetting(prisma, shopSessionJtiKey(customer.telegramId), newJti());
    }
    void reply.clearCookie(SHOP_COOKIE_NAME, { path: "/" });
    return reply.code(303).redirect("/");
  });
};

export default authRoutes;
