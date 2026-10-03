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
 * "anyone who has ever guessed the code" is the throttling below plus the
 * `isGuest` gate further down: a per-client limiter (per IP, per /64 for
 * IPv6), an IP-independent cap on failed guesses per date prefix and
 * overall (backend audit Task C1), and the gate refusing anything but a
 * guest-owned order. A cross-site request is refused outright (login CSRF).
 *
 * What a tracked session can NOT do is claim the row: setting login
 * credentials on a guest row also requires the order's contact email
 * (`POST /api/v1/account/settings/credentials`), so a guessed code exposes
 * that one guest's orders but cannot be turned into a permanent account.
 *
 * The React `/track` page that calls this is a SEPARATE task — this file is
 * server-side only.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getOrderByCode } from "@app/db";
import { establishSession } from "./auth";
import { clientIp, recordTrackFailure, trackLookupRateLimited, trackTargetLockedOut } from "../rateLimit";
import { sessionMintOriginOk } from "./cart";

const apiTrackRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { order_code?: string } }>("/track", async (req, reply) => {
    // A cross-site page must not be able to mint a session in the visitor's
    // browser (login CSRF) — checked before anything else, and before any
    // quota is spent, since such a request never reaches a lookup at all.
    if (!sessionMintOriginOk(req)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }

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

    // req.body isn't schema-validated, so order_code can arrive as anything
    // JSON allows (a number, an array, …) — guard the type before calling
    // string methods on it, or a non-string value throws and turns this
    // endpoint's one generic 404 into a 500 instead.
    const orderCode =
      typeof req.body?.order_code === "string" ? req.body.order_code.trim().toUpperCase() : "";
    if (!orderCode) return reject();

    // IP-independent cap on FAILED guesses (per date prefix, and overall) —
    // the per-IP limiter alone falls to anyone with many addresses. Same
    // generic 429 as the per-IP limiter, and checked before the lookup, so it
    // says nothing about whether this particular code exists.
    if (trackTargetLockedOut(orderCode)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const order = await getOrderByCode(prisma, orderCode);
    if (!order) {
      recordTrackFailure(orderCode);
      return reject();
    }

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
    if (order.user.isGuest !== true) {
      recordTrackFailure(orderCode);
      return reject();
    }

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
