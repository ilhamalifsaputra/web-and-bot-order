/**
 * POST /api/v1/topup/check-account — the "kelebihan" (advantage) feature the
 * original UX reference site had over a plain form: a live in-game nickname
 * lookup on the buyer's account field, wired into InstantBuyPage.tsx's
 * debounced live-typing UX (Task 7, the final task of the Digiflazz top-up
 * pilot). Backed by KokinPay (@app/core/suppliers/kokinpay), a separate
 * service from Digiflazz chosen specifically for this lookup.
 *
 * CRITICAL, per the plan's explicit instruction: this endpoint must NEVER
 * surface an error to the buyer or block checkout. Every non-happy path —
 * no nicknameCheckGameCode configured for the denomination, no KokinPay
 * credentials set, or the live KokinPay call itself throwing (network/HTTP
 * failure) — degrades to the SAME `{ available: false }` response. The
 * client (InstantBuyPage.tsx) treats `available: false` as "show nothing,
 * the field behaves exactly as it does today" — silent degradation, not a
 * visible failure state. This is a read-only, unauthenticated, no-DB-write
 * convenience lookup, so there is nothing here for logAdminAction to audit.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getDenomination, getKokinpayCreds } from "@app/db";
import { checkGameNickname } from "@app/core/suppliers/kokinpay";
import { logger } from "@app/core/logger";
import { clientIp, nicknameCheckRateLimited } from "../rateLimit";

interface CheckAccountResponse {
  available: boolean;
  valid?: boolean;
  nickname?: string | null;
}

const NOT_AVAILABLE: CheckAccountResponse = { available: false };

const apiTopupRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { denomination_id?: number; id?: string; server?: string } }>(
    "/topup/check-account",
    async (req, reply) => {
      // Spent even by requests that go on to degrade below — this is a
      // live-typing lookup fired on every debounced keystroke, so the quota
      // has to bound call volume regardless of how the request resolves.
      if (nicknameCheckRateLimited(clientIp(req))) {
        return reply.code(429).send(NOT_AVAILABLE);
      }

      const denominationId = Number(req.body?.denomination_id);
      const accountId = typeof req.body?.id === "string" ? req.body.id.trim() : "";
      if (!Number.isInteger(denominationId) || denominationId <= 0 || !accountId) {
        // Malformed input degrades the same as "no check configured" — this
        // endpoint has no error shape for the buyer to see.
        return reply.send(NOT_AVAILABLE);
      }

      const denomination = await getDenomination(prisma, denominationId);
      const gameCode = denomination?.nicknameCheckGameCode;
      if (!gameCode) return reply.send(NOT_AVAILABLE);

      const creds = await getKokinpayCreds(prisma);
      if (!creds) return reply.send(NOT_AVAILABLE);

      const server = typeof req.body?.server === "string" ? req.body.server.trim() || undefined : undefined;

      try {
        const result = await checkGameNickname(creds, { gameCode, id: accountId, server });
        return reply.send({ available: true, valid: result.valid, nickname: result.nickname });
      } catch (err) {
        // The KokinPay client's own error message is already credential-free
        // (packages/core/src/suppliers/kokinpay.ts's guarantee) — safe to log,
        // but this is a debounced live-typing call, so a single flaky lookup
        // is expected background noise, not something worth an admin-facing
        // warn-level entry. The buyer never sees this at all: the response
        // below degrades exactly like "no check configured."
        logger.info(
          { err },
          "KokinPay nickname check failed for one storefront lookup — degrading to no live check for this keystroke, buyer unaffected.",
        );
        return reply.send(NOT_AVAILABLE);
      }
    },
  );
};

export default apiTopupRoutes;
