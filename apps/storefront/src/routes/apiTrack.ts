/**
 * POST /api/v1/track — order code + email session recovery for a guest
 * buyer (Task 5, guest checkout). A guest already gets a 30-day session at
 * checkout (routes/api.ts establishGuestCustomer), but that cookie can be
 * lost or the buyer can switch devices; this endpoint is the recovery path:
 * it turns a correct (order code, email) pair back into a live session for
 * the guest `User` row that owns the order.
 *
 * The React `/track` page that calls this is a SEPARATE task — this file is
 * server-side only.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getOrderByCode } from "@app/db";
import { establishSession } from "./auth";
import { clientIp, trackLookupRateLimited } from "../rateLimit";
import { constantTimeEqual } from "../auth";

const apiTrackRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { order_code?: string; email?: string } }>("/track", async (req, reply) => {
    // Rate limit BEFORE any query — this endpoint accepts an order code as
    // one of its two inputs, so it's a guessing oracle by nature. The quota
    // must be spent even by attempts that go on to fail every other check
    // below, or an attacker could probe for free as long as each guess was
    // wrong somewhere past this point.
    if (trackLookupRateLimited(clientIp(req))) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    // Every rejection below — missing input, no such order, an order that
    // belongs to a REGISTERED (non-guest) account, or a mismatched email —
    // funnels through this single generic 404. Distinguishing any of them
    // (e.g. "no such order" vs "wrong email") would turn the endpoint into
    // an oracle for which order codes exist; a single shared response keeps
    // that unobservable.
    const reject = () => reply.code(404).send({ error: "web.track_not_found" });

    const orderCode = (req.body?.order_code ?? "").trim().toUpperCase();
    const email = (req.body?.email ?? "").trim().toLowerCase();
    if (!orderCode || !email) return reject();

    const order = await getOrderByCode(prisma, orderCode);
    if (!order) return reject();

    // isGuest gate is mandatory: an order owned by a REGISTERED account must
    // never be reachable through code+email alone — that would let anyone
    // who learns the order code and the account's login email bypass the
    // account's password entirely. Guest rows are the only ones this path is
    // allowed to open.
    if (order.user.isGuest !== true) return reject();
    if (!order.user.guestEmail) return reject();
    if (!constantTimeEqual(email, order.user.guestEmail.trim().toLowerCase())) return reject();

    // establishSession rotates the session jti, so a guest session already
    // live on another device/browser is invalidated by this call. That's
    // intentional and accepted: proving ownership of the guest email proves
    // ownership of the order, and rotating cuts off a session that may have
    // leaked (e.g. a shared/public device) rather than leaving it valid
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
