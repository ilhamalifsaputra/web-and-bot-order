/** Pemulihan guest memerlukan token acak berumur 30 hari, terikat satu order. */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getOrderByCode } from "@app/db";
import { verifyGuestOrderAccess } from "@app/core/guestOrderAccess";
import { establishSession } from "./auth";
import { clientIp, recordTrackFailure, trackLookupRateLimited, trackTargetLockedOut } from "../rateLimit";
import { sessionMintOriginOk } from "./cart";

const apiTrackRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { order_code?: string; access_token?: string } }>("/track", async (req, reply) => {
    // A cross-site page must not be able to mint a session in the visitor's
    // browser (login CSRF) — checked before anything else, and before any
    // quota is spent, since such a request never reaches a lookup at all.
    if (!sessionMintOriginOk(req)) {
      return reply.code(403).send({ error: "csrf_failed" });
    }

    // Kuota berlaku sebelum verifikasi token dan query database.
    if (trackLookupRateLimited(clientIp(req))) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    const reject = () => reply.code(404).send({ error: "web.track_not_found" });

    // req.body isn't schema-validated, so order_code can arrive as anything
    // JSON allows (a number, an array, …) — guard the type before calling
    // string methods on it, or a non-string value throws and turns this
    // endpoint's one generic 404 into a 500 instead.
    const orderCode =
      typeof req.body?.order_code === "string" ? req.body.order_code.trim().toUpperCase() : "";
    if (!orderCode || orderCode.length > 128) return reject();

    // IP-independent cap on FAILED guesses (per date prefix, and overall) —
    // the per-IP limiter alone falls to anyone with many addresses. Same
    // generic 429 as the per-IP limiter, and checked before the lookup, so it
    // says nothing about whether this particular code exists.
    if (trackTargetLockedOut(orderCode)) {
      return reply.code(429).send({ error: "error.rate_limited" });
    }

    if (!verifyGuestOrderAccess(req.body?.access_token, orderCode)) {
      recordTrackFailure(orderCode);
      return reject();
    }

    const order = await getOrderByCode(prisma, orderCode);
    if (!order) {
      recordTrackFailure(orderCode);
      return reject();
    }

    const owner = await prisma.user.findUnique({ where: { id: order.user.id }, select: { banned: true } });
    if (order.user.isGuest !== true || !owner || owner.banned) {
      recordTrackFailure(orderCode);
      return reject();
    }

    const session = await establishSession(req, reply, { id: order.user.id, telegramId: order.user.telegramId }, order.orderCode);

    return reply.code(200).send({ redirect: `/account/orders/${order.orderCode}`, csrf_token: session.csrf });
  });
};

export default apiTrackRoutes;
