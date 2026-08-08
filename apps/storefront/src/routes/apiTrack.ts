/**
 * POST /api/v1/track — order code session recovery for a guest buyer (Task
 * 5, guest checkout). A guest already gets a 30-day session at checkout
 * (routes/api.ts establishGuestCustomer), but that cookie can be lost or the
 * buyer can switch devices; this endpoint is the recovery path: it turns a
 * bare order code back into a live session for the guest `User` row that
 * owns the order.
 *
 * The order code IS the credential here — by product decision there is no
 * second factor (no email, no password) standing behind it. Anyone who has
 * the code can open the order and its session. What stops that from being
 * "anyone who has ever seen the code" is only the per-IP rate limit below
 * plus the `isGuest` gate further down: the limiter caps how many codes a
 * single IP can try, and the gate refuses anything but a guest-owned order.
 *
 * The React `/track` page that calls this is a SEPARATE task — this file is
 * server-side only.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getOrderByCode } from "@app/db";
import { establishSession } from "./auth";
import { clientIp, trackLookupRateLimited } from "../rateLimit";

const apiTrackRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { order_code?: string } }>("/track", async (req, reply) => {
    // Rate limit BEFORE any query — the order code is now the endpoint's
    // only input and its only credential, so this limiter is the entire
    // defense against brute-forcing it. The quota must be spent even by
    // attempts that go on to fail the checks below, or an attacker could
    // probe for free as long as each guess was wrong somewhere past this
    // point.
    if (trackLookupRateLimited(clientIp(req))) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    // Every rejection below — missing input, no such order, or an order
    // that belongs to a REGISTERED (non-guest) account — funnels through
    // this single generic 404. Distinguishing any of them (e.g. "no such
    // order" vs "not a guest order") would turn the endpoint into an oracle
    // for which order codes exist; a single shared response keeps that
    // unobservable.
    const reject = () => reply.code(404).send({ error: "web.track_not_found" });

    const orderCode = (req.body?.order_code ?? "").trim().toUpperCase();
    if (!orderCode) return reject();

    const order = await getOrderByCode(prisma, orderCode);
    if (!order) return reject();

    // isGuest gate is mandatory and is now the ONLY thing standing between
    // an order code and a session: an order owned by a REGISTERED account
    // must never be reachable through the code alone — that would let
    // anyone who learns the order code bypass the account's password
    // entirely. Guest rows are the only ones this path is allowed to open.
    //
    // The dropped `guestEmail` presence check is safe to drop, not just
    // convenient: `createGuestUser` is the only writer of `isGuest: true`
    // and always sets `guestEmail` in the same `create`, and
    // `setLoginCredentials` is the only place that clears `isGuest`, and it
    // nulls `guestEmail` in the same `update`. So `isGuest === true` already
    // implies `guestEmail !== null` on every reachable row; this gate alone
    // carries the whole guarantee.
    if (order.user.isGuest !== true) return reject();

    // establishSession rotates the session jti, so a guest session already
    // live on another device/browser is invalidated by this call. That's
    // intentional and accepted: holding the order code is treated as proof
    // of ownership of the order, and rotating cuts off a session that may
    // have leaked (e.g. a shared/public device) rather than leaving it valid
    // alongside the new one.
    //
    // establishSession also migrates the CALLER'S guest-cart cookie (if any)
    // into CartItem rows owned by this guest user. The effect is small here
    // — whoever is recovering a session usually isn't mid-way through
    // building a new cart — but it's the same code path guest checkout uses,
    // so it's worth flagging rather than being a surprise.
    const session = await establishSession(req, reply, { id: order.user.id, telegramId: order.user.telegramId });

    return reply.code(200).send({ redirect: `/account/orders/${order.orderCode}`, csrf_token: session.csrf });
  });
};

export default apiTrackRoutes;
