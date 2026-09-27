/**
 * Buyer display preferences for the React SPA.
 *
 * POST /api/v1/preferences/currency — body `{ currency: "USD" | "IDR" }`.
 * Display only: it changes which currency prices are SHOWN in, never what a
 * payment rail charges (pricing.ts / checkout are untouched by this).
 *
 * Works for everyone, like the cart: anonymous visitors and guest sessions
 * get the `shop_currency` cookie only; a signed-in, non-guest account also
 * gets `User.preferredCurrency` written, so the Telegram bot (same row) shows
 * the same currency. CSRF follows the cart's shared `csrfOk` rule — anonymous
 * requests are covered by SameSite=Lax, any session needs the x-csrf-token
 * header plus a same-site Origin.
 *
 * The route is a JSON twin of `GET /lang` (routes/home.ts) in spirit, but a
 * POST: it writes to the DB for signed-in accounts, so it must not be a GET.
 */
import type { FastifyPluginAsync } from "fastify";
import { parseDisplayCurrency } from "@app/core/enums";
import { prisma, setUserPreferredCurrency } from "@app/db";
import { optionalCustomer } from "../plugins/auth";
import { writeCurrencyCookie } from "../shop";
import { csrfOk } from "./cart";

const apiPreferencesRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { currency?: unknown } | undefined }>("/preferences/currency", async (req, reply) => {
    const customer = await optionalCustomer(req);
    if (!csrfOk(req, customer)) return reply.code(403).send({ error: "csrf_failed" });

    const currency = parseDisplayCurrency(req.body?.currency);
    // Not an i18n key: the SPA only ever offers the two fixed choices, so a
    // 400 here means a bug or a hand-crafted request, not something to translate.
    if (!currency) return reply.code(400).send({ error: "currency_invalid" });

    if (customer && !customer.user.isGuest) {
      await setUserPreferredCurrency(prisma, customer.userId, currency);
    }
    writeCurrencyCookie(reply, currency);
    return reply.send({ currency });
  });
};

export default apiPreferencesRoutes;
