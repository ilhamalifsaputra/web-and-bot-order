/**
 * POST /api/v1/topup/check-account — the "kelebihan" (advantage) feature the
 * original UX reference site had over a plain form: a live in-game nickname
 * lookup on the buyer's account field, wired into InstantBuyPage.tsx's
 * debounced live-typing UX (Task 7, the final task of the Digiflazz top-up
 * pilot). Backed by KokinPay (@app/core/suppliers/kokinpay), a separate
 * service from Digiflazz chosen specifically for this lookup.
 *
 * Region-check Task C added a second, fully independent lookup on the same
 * request/response cycle: a VIP-Reseller (@app/core/suppliers/vipreseller)
 * region check that flags `region_mismatch: true` when the account's live
 * region disagrees with the denomination's admin-declared
 * `expectedRegionCode`. "Fully independent" is load-bearing here — the
 * KokinPay nickname-check and the VIP-Reseller region-check must each run
 * (or gracefully skip) regardless of whether the OTHER provider's
 * credentials/config are present. That's why, past the three shared
 * early-return gates below, this handler builds ONE `response` object and
 * runs both provider blocks in their own try/catch, each only setting its
 * own fields on `response` — never an early `reply.send()` per branch, which
 * would let one provider's return skip the other's check entirely.
 *
 * Reuses `nicknameCheckGameCode` as the VIP-Reseller game code too (see
 * Region-check Task C's brief) — there is deliberately no separate
 * "VIP-Reseller game code" admin field, so the region-check can only ever
 * run when `nicknameCheckGameCode` is ALSO set, in addition to
 * `expectedRegionCode`. This is a documented pilot-scope limitation, not a
 * bug.
 *
 * CRITICAL, per the plan's explicit instruction: this endpoint must NEVER
 * surface an error to the buyer or block checkout. Every non-happy path —
 * no nicknameCheckGameCode configured for the denomination, no KokinPay
 * credentials set, no expectedRegionCode configured, no VIP-Reseller
 * credentials set, or either live supplier call throwing (network/HTTP
 * failure) — degrades to that provider's fields simply being absent from
 * `response`. The client (InstantBuyPage.tsx) treats `available: false` /
 * `region_mismatch` absent as "show nothing, the field behaves exactly as it
 * does today" — silent degradation, not a visible failure state. This is a
 * read-only, unauthenticated, no-DB-write convenience lookup, so there is
 * nothing here for logAdminAction to audit.
 */
import type { FastifyPluginAsync } from "fastify";
import { prisma, getDenomination, getKokinpayCreds, getVipResellerCreds } from "@app/db";
import { checkGameNickname } from "@app/core/suppliers/kokinpay";
import { checkGameRegion } from "@app/core/suppliers/vipreseller";
import { logger } from "@app/core/logger";
import { clientIp, nicknameCheckRateLimited } from "../rateLimit";

interface CheckAccountResponse {
  available: boolean;
  valid?: boolean;
  nickname?: string | null;
  region_mismatch?: boolean;
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
      // Shared game-code prerequisite for BOTH providers, per the design
      // decision to reuse nicknameCheckGameCode as the VIP-Reseller code too
      // — a denomination with expectedRegionCode set but this left blank
      // silently never runs the region check either (see top-of-file comment).
      // Checked together with the null-denomination case so `denomination` is
      // narrowed non-null for the rest of this handler.
      if (!denomination || !denomination.nicknameCheckGameCode) return reply.send(NOT_AVAILABLE);
      const gameCode = denomination.nicknameCheckGameCode;

      const server = typeof req.body?.server === "string" ? req.body.server.trim() || undefined : undefined;

      // One shared response object — both provider blocks below only ADD
      // fields to it, never `reply.send()` on their own, so neither provider
      // can short-circuit the other.
      const response: CheckAccountResponse = { available: false };

      // --- KokinPay nickname-check block (Task 7 logic, unchanged in
      // substance, restructured to set `response` instead of returning). ---
      const kokinpayCreds = await getKokinpayCreds(prisma);
      if (kokinpayCreds) {
        try {
          const result = await checkGameNickname(kokinpayCreds, { gameCode, id: accountId, server });
          response.available = true;
          response.valid = result.valid;
          response.nickname = result.nickname;
        } catch (err) {
          // The KokinPay client's own error message is already credential-free
          // (packages/core/src/suppliers/kokinpay.ts's guarantee) — safe to log,
          // but this is a debounced live-typing call, so a single flaky lookup
          // is expected background noise, not something worth an admin-facing
          // warn-level entry. The buyer never sees this at all: `response`
          // simply keeps `available: false`, same as "no check configured."
          logger.info(
            { err },
            "KokinPay nickname check failed for one storefront lookup — degrading to no live check for this keystroke, buyer unaffected.",
          );
        }
      }

      // --- VIP-Reseller region-check block (Region-check Task C, new).
      // Fully independent of the KokinPay block above: runs (or skips) purely
      // off `denomination.expectedRegionCode` + its own credentials, and only
      // ever ADDS `region_mismatch: true` to `response` — every other outcome
      // (not configured, no creds, no country data, a throw) leaves
      // `region_mismatch` unset, never present in the JSON. ---
      if (denomination.expectedRegionCode) {
        const vipResellerCreds = await getVipResellerCreds(prisma);
        if (vipResellerCreds) {
          try {
            const result = await checkGameRegion(vipResellerCreds, { gameCode, id: accountId, server });
            if (
              result.countryCode &&
              result.countryCode.toLowerCase() !== denomination.expectedRegionCode.toLowerCase()
            ) {
              response.region_mismatch = true;
            }
          } catch (err) {
            // checkGameRegion's own thrown errors are already static/
            // credential-free (packages/core/src/suppliers/vipreseller.ts's
            // guarantee), same info-level/no-buyer-visible-effect precedent
            // as the KokinPay catch block above.
            logger.info(
              { err },
              "VIP-Reseller region check failed for one storefront lookup — degrading to no region signal for this keystroke, buyer unaffected.",
            );
          }
        }
      }

      return reply.send(response);
    },
  );
};

export default apiTopupRoutes;
